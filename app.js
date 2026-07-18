const API_BASE = "https://api.warframe.market/v1";
const FANDOM_API = "https://warframe.fandom.com/api.php";
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const SYNDICATE_PAGES = [
  ["Steel_Meridian", "Steel Meridian"],
  ["Arbiters_of_Hexis", "Arbiters of Hexis"],
  ["Cephalon_Suda", "Cephalon Suda"],
  ["The_Perrin_Sequence", "The Perrin Sequence"],
  ["Red_Veil", "Red Veil"],
  ["New_Loka", "New Loka"],
];

let allResults = [];
let sortKey = "score";
let sortAsc = false;
let activeSyndicates = new Set();
let syndicateMode = "all";
let liveMode = false;

const content = document.getElementById("content");
const statsBar = document.getElementById("statsBar");
const searchInput = document.getElementById("search");
const platformSelect = document.getElementById("platform");

searchInput.addEventListener("input", () => renderTable());

function showLoader(text) {
  content.innerHTML = `<div class="loader"><div class="spinner"></div><div class="loader-text">${text}</div><div class="progress-text" id="progressText"></div></div>`;
}

function setProgress(text) {
  const el = document.getElementById("progressText");
  if (el) el.textContent = text;
}

function deriveUrlName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]+/g, "");
}

function proxiedFetch(url) {
  for (const proxy of CORS_PROXIES) {
    return fetch(proxy(url)).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }
}

function directFetch(url) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

async function smartFetch(url) {
  try {
    return await directFetch(url);
  } catch {
    for (const proxy of CORS_PROXIES) {
      try {
        const resp = await fetch(proxy(url));
        if (!resp.ok) continue;
        return await resp.json();
      } catch { continue; }
    }
    throw new Error(`Failed: ${url}`);
  }
}

function parseSynOfferBox(wikitext, syndicateName) {
  const mods = [];
  const regex = /\{\{SynOfferBox\|([^}]*)\}\}/g;
  let match;
  while ((match = regex.exec(wikitext)) !== null) {
    const parts = match[1].split("|");
    if (parts.length < 5) continue;
    const pageName = parts[1].trim();
    const label = parts[2].trim();
    const costRaw = parts[3].trim();
    const rankInfo = parts[4].trim();
    const costDigits = costRaw.replace(/[^0-9]+/g, "");
    const standingCost = costDigits ? parseInt(costDigits) : 25000;
    if (standingCost < 20000) continue;
    if (!/\([^)]+\)/.test(label)) continue;
    if (!rankInfo.startsWith("Rank")) continue;
    const name = pageName || label;
    const urlName = deriveUrlName(name);
    if (!urlName) continue;
    mods.push({ name, url_name: urlName, standing_cost: standingCost, syndicates: [syndicateName] });
  }
  return mods;
}

async function fetchSyndicateMods() {
  const combined = {};
  for (const [page, synName] of SYNDICATE_PAGES) {
    setProgress(`Wiki: ${synName}...`);
    try {
      const data = await smartFetch(`${FANDOM_API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&origin=*`);
      const wikitext = data.parse.wikitext["*"];
      for (const m of parseSynOfferBox(wikitext, synName)) {
        if (combined[m.url_name]) {
          const e = combined[m.url_name];
          e.syndicates = [...new Set([...e.syndicates, ...m.syndicates])].sort();
          if (m.standing_cost < e.standing_cost) e.standing_cost = m.standing_cost;
        } else {
          combined[m.url_name] = m;
        }
      }
    } catch (err) {
      console.error(`Wiki ${page} failed:`, err.message);
    }
  }
  return Object.values(combined);
}

async function fetchStatistics48h(urlName, platform) {
  try {
    const data = await smartFetch(`${API_BASE}/items/${urlName}/statistics?platform=${platform}`);
    const arr = data.payload?.statistics_closed?.["48hours"];
    if (!Array.isArray(arr) || arr.length === 0) return { volume: null, median: null };
    let volume = 0, lastPoint = null;
    for (const p of arr) {
      if (typeof p !== "object" || p === null) continue;
      lastPoint = p;
      if (typeof p.volume === "number") volume += p.volume;
    }
    let median = null;
    if (lastPoint) {
      if (typeof lastPoint.median === "number") median = lastPoint.median;
      else if (typeof lastPoint.avg_price === "number") median = lastPoint.avg_price;
    }
    return { volume, median };
  } catch { return { volume: null, median: null }; }
}

async function fetchOrdersBestByRank(urlName, platform) {
  try {
    const data = await smartFetch(`${API_BASE}/items/${urlName}/orders?platform=${platform}`);
    const orders = data.payload?.orders || [];
    const best = {};
    for (const o of orders) {
      if (o.order_type !== "sell") continue;
      const st = o.user?.status;
      if (st !== "ingame" && st !== "online") continue;
      if (typeof o.platinum !== "number") continue;
      const rank = o.mod_rank || 0;
      if (best[rank] === undefined || o.platinum < best[rank]) best[rank] = o.platinum;
    }
    return best;
  } catch { return {}; }
}

async function fetchOneMod(m, platform) {
  const [stats, bestByRank] = await Promise.all([
    fetchStatistics48h(m.url_name, platform),
    fetchOrdersBestByRank(m.url_name, platform),
  ]);
  const vals = Object.values(bestByRank);
  const chosenPrice = vals.length > 0 ? Math.min(...vals) : stats.median;
  let chosenRank = null;
  if (vals.length > 0) {
    const min = Math.min(...vals);
    for (const [r, p] of Object.entries(bestByRank)) {
      if (p === min) { chosenRank = parseInt(r); break; }
    }
  }
  const platPerStanding = chosenPrice != null && m.standing_cost > 0 ? chosenPrice / m.standing_cost : null;
  const score = platPerStanding != null && stats.volume != null ? platPerStanding * stats.volume : null;
  return {
    name: m.name, url_name: m.url_name, standing_cost: m.standing_cost,
    syndicates: m.syndicates || [], best_by_rank: bestByRank,
    volume_48h: stats.volume, median_48h: stats.median,
    chosen_price: chosenPrice, chosen_rank: chosenRank,
    plat_per_standing: platPerStanding, score,
    market_url: `https://warframe.market/items/${m.url_name}`,
  };
}

async function fetchMarketData(mods, platform) {
  const results = [];
  const CONCURRENCY = 4;
  let i = 0;

  async function worker() {
    while (i < mods.length) {
      const idx = i++;
      setProgress(`Market: ${idx + 1}/${mods.length} — ${mods[idx].url_name}`);
      try {
        results.push(await fetchOneMod(mods[idx], platform));
      } catch (err) {
        console.error(`Failed: ${mods[idx].url_name}`, err.message);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, mods.length); w++) workers.push(worker());
  await Promise.all(workers);

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return results;
}

// === Cached mode ===
async function loadCached() {
  showLoader("Loading cached data...");
  try {
    const resp = await fetch(`data/results.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error("No cached data");
    const data = await resp.json();
    allResults = data.results || [];
    liveMode = false;
    updateBanner(data.updated_at);
    renderTable();
  } catch {
    content.innerHTML = '<div class="loader">No cached data. Click "Refresh Now" to fetch live.</div>';
  }
}

// === Live mode ===
async function loadLive() {
  const btn = document.getElementById("refreshBtn");
  if (btn) btn.disabled = true;
  showLoader("Starting live fetch...");
  statsBar.style.display = "none";
  liveMode = true;

  const platform = platformSelect.value;
  try {
    const mods = await fetchSyndicateMods();
    if (!mods.length) throw new Error("No mods found from wiki");
    allResults = await fetchMarketData(mods, platform);
    try { localStorage.setItem("wf_mods_cache", JSON.stringify({ platform, updated_at: new Date().toISOString(), results: allResults })); } catch {}
    updateBanner(new Date().toISOString());
    renderTable();
  } catch (err) {
    content.innerHTML = `<div class="loader">Error: ${err.message}</div>`;
  }
  if (btn) btn.disabled = false;
}

function updateBanner(updatedAt) {
  if (!updatedAt) return;
  const d = new Date(updatedAt);
  document.getElementById("statUpdated").textContent =
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("modeLabel").innerHTML = liveMode ? 'Source: <strong style="color:var(--green)">Live</strong>' : 'Source: <strong>Cached</strong>';
}

function toggleSyndicate(btn) {
  const synd = btn.dataset.synd;
  if (synd === "all") {
    syndicateMode = "all";
    activeSyndicates.clear();
    document.querySelectorAll(".syndicate-btn").forEach((b) => b.classList.toggle("active", b.dataset.synd === "all"));
  } else {
    syndicateMode = "custom";
    document.querySelector('.syndicate-btn[data-synd="all"]').classList.remove("active");
    if (activeSyndicates.has(synd)) { activeSyndicates.delete(synd); btn.classList.remove("active"); }
    else { activeSyndicates.add(synd); btn.classList.add("active"); }
    if (activeSyndicates.size === 0) {
      syndicateMode = "all";
      document.querySelector('.syndicate-btn[data-synd="all"]').classList.add("active");
    }
  }
  renderTable();
}

function getFiltered() {
  const query = searchInput.value.trim().toLowerCase();
  return allResults.filter((r) => {
    if (query && !r.name.toLowerCase().includes(query)) return false;
    if (syndicateMode === "custom" && !r.syndicates.some((s) => activeSyndicates.has(s))) return false;
    return true;
  });
}

function fmt(x, decimals = 0) {
  if (x == null) return '<span class="no-data">-</span>';
  if (decimals > 0) return x.toFixed(decimals);
  return String(x);
}

function scoreClass(score) {
  if (score == null) return "";
  if (score >= 0.01) return "high-score";
  if (score >= 0.001) return "mid-score";
  return "low-score";
}

function renderTable() {
  const filtered = getFiltered();
  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) av = sortAsc ? Infinity : -Infinity;
    if (bv == null) bv = sortAsc ? Infinity : -Infinity;
    if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? av - bv : bv - av;
  });

  if (sorted.length === 0 && allResults.length === 0) {
    content.innerHTML = '<div class="loader">No data. Click "Refresh Now" to fetch.</div>';
    statsBar.style.display = "none";
    return;
  }

  if (sorted.length === 0) {
    content.innerHTML = '<div class="loader">No results match your filters.</div>';
    statsBar.style.display = "flex";
    document.getElementById("statTotal").textContent = allResults.length;
    document.getElementById("statShown").textContent = 0;
    return;
  }

  const prices = sorted.filter((r) => r.chosen_price != null).map((r) => r.chosen_price);
  const scores = sorted.filter((r) => r.score != null).map((r) => r.score);
  const avgPrice = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  document.getElementById("statTotal").textContent = allResults.length;
  document.getElementById("statAvgPrice").textContent = avgPrice != null ? avgPrice.toFixed(1) : "-";
  document.getElementById("statAvgScore").textContent = avgScore != null ? avgScore.toFixed(6) : "-";
  document.getElementById("statShown").textContent = sorted.length;
  statsBar.style.display = "flex";

  const cols = [
    { key: "name", label: "Mod" },
    { key: "standing_cost", label: "Standing" },
    { key: "syndicates", label: "Syndicates" },
    { key: "chosen_price", label: "Price (P)" },
    { key: "chosen_rank", label: "Rank" },
    { key: "volume_48h", label: "Volume 48h" },
    { key: "plat_per_standing", label: "P/Standing" },
    { key: "score", label: "Score" },
  ];

  let html = "<table><thead><tr>";
  for (const c of cols) {
    const s = sortKey === c.key;
    html += `<th class="${s ? "sorted" : ""}" onclick="sortBy('${c.key}')">${c.label}<span class="arrow">${s ? (sortAsc ? " \u25B2" : " \u25BC") : ""}</span></th>`;
  }
  html += "<th>Link</th></tr></thead><tbody>";

  for (const r of sorted) {
    const tags = r.syndicates.length > 0
      ? r.syndicates.map((s) => `<span class="synd-tag" data-synd="${s}">${s}</span>`).join("")
      : '<span class="no-data">-</span>';
    const rd = r.best_by_rank && Object.keys(r.best_by_rank).length > 0
      ? Object.entries(r.best_by_rank).sort((a, b) => Number(a[0]) - Number(b[0])).map(([rank, price]) => `R${rank}: ${price}p`).join(", ")
      : "";

    html += `<tr>
      <td class="name"><a href="${r.market_url}" target="_blank">${r.name}</a></td>
      <td class="number">${r.standing_cost.toLocaleString()}</td>
      <td class="synd-cell">${tags}</td>
      <td class="number">${fmt(r.chosen_price, 1)}</td>
      <td class="number">${r.chosen_rank != null ? "Rank " + r.chosen_rank : '<span class="no-data">-</span>'}${rd ? `<div class="rank-detail">${rd}</div>` : ""}</td>
      <td class="number">${fmt(r.volume_48h)}</td>
      <td class="number">${fmt(r.plat_per_standing, 6)}</td>
      <td class="number ${scoreClass(r.score)}">${fmt(r.score, 6)}</td>
      <td><a href="${r.market_url}" target="_blank" style="color:var(--accent2);text-decoration:none;font-size:12px;">Open</a></td>
    </tr>`;
  }
  html += "</tbody></table>";
  content.innerHTML = html;
}

function sortBy(key) {
  if (sortKey === key) sortAsc = !sortAsc;
  else { sortKey = key; sortAsc = key === "name"; }
  renderTable();
}

function exportCSV() {
  if (!allResults.length) return alert("No data to export.");
  const filtered = getFiltered();
  const headers = ["Name", "Standing", "Syndicates", "Price (P)", "Rank", "Volume 48h", "P/Standing", "Score", "URL"];
  const rows = filtered.map((r) => [
    `"${r.name}"`, r.standing_cost, `"${r.syndicates.join(", ")}"`,
    r.chosen_price ?? "", r.chosen_rank ?? "", r.volume_48h ?? "",
    r.plat_per_standing != null ? r.plat_per_standing.toFixed(6) : "",
    r.score != null ? r.score.toFixed(6) : "", r.market_url,
  ]);
  let csv = headers.join(",") + "\n";
  for (const row of rows) csv += row.join(",") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "warframe_mods_analysis.csv";
  a.click();
}

// Load cached on start
loadCached();
