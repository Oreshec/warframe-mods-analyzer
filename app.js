let allResults = [];
let sortKey = "score";
let sortAsc = false;
let activeSyndicates = new Set();
let syndicateMode = "all";

const content = document.getElementById("content");
const statsBar = document.getElementById("statsBar");
const searchInput = document.getElementById("search");
const platformSelect = document.getElementById("platform");

searchInput.addEventListener("input", () => renderTable());

function showLoader(text) {
  content.innerHTML = `<div class="loader"><div class="spinner"></div><div class="loader-text">${text}</div></div>`;
}

async function loadData() {
  showLoader("Loading market data...");
  statsBar.style.display = "none";
  const platform = platformSelect.value;

  try {
    const resp = await fetch(`data/results.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error("Data not available yet. Try again later.");
    const data = await resp.json();

    let results = data.results || [];
    if (data.platform && data.platform !== platform) {
      results = results.filter(() => false);
    }

    allResults = results;

    const updated = data.updated_at ? new Date(data.updated_at) : null;
    document.getElementById("statUpdated").textContent = updated
      ? updated.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " +
        updated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : "-";

    renderTable();
  } catch (err) {
    content.innerHTML = `<div class="loader">Failed to load data: ${err.message}<br><small>This may be the first run. Data will appear after GitHub Actions runs.</small></div>`;
  }
}

function toggleSyndicate(btn) {
  const synd = btn.dataset.synd;

  if (synd === "all") {
    syndicateMode = "all";
    activeSyndicates.clear();
    document.querySelectorAll(".syndicate-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.synd === "all");
    });
  } else {
    syndicateMode = "custom";
    document.querySelector('.syndicate-btn[data-synd="all"]').classList.remove("active");
    if (activeSyndicates.has(synd)) {
      activeSyndicates.delete(synd);
      btn.classList.remove("active");
    } else {
      activeSyndicates.add(synd);
      btn.classList.add("active");
    }
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
    if (syndicateMode === "custom") {
      if (!r.syndicates.some((s) => activeSyndicates.has(s))) return false;
    }
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

  if (sorted.length === 0) {
    content.innerHTML = '<div class="loader">No results match your filters.</div>';
    statsBar.style.display = allResults.length > 0 ? "flex" : "none";
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
    const isSorted = sortKey === c.key;
    const arrow = isSorted ? (sortAsc ? " \u25B2" : " \u25BC") : "";
    html += `<th class="${isSorted ? "sorted" : ""}" onclick="sortBy('${c.key}')">${c.label}<span class="arrow">${arrow}</span></th>`;
  }
  html += "<th>Link</th></tr></thead><tbody>";

  for (const r of sorted) {
    const syndTags = r.syndicates.length > 0
      ? r.syndicates.map((s) => `<span class="synd-tag" data-synd="${s}">${s}</span>`).join("")
      : '<span class="no-data">-</span>';

    const rankDetail = r.best_by_rank && Object.keys(r.best_by_rank).length > 0
      ? Object.entries(r.best_by_rank).sort((a, b) => Number(a[0]) - Number(b[0])).map(([rank, price]) => `R${rank}: ${price}p`).join(", ")
      : "";

    html += `<tr>
      <td class="name"><a href="${r.market_url}" target="_blank" rel="noopener">${r.name}</a></td>
      <td class="number">${r.standing_cost.toLocaleString()}</td>
      <td class="synd-cell">${syndTags}</td>
      <td class="number">${fmt(r.chosen_price, 1)}</td>
      <td class="number">${r.chosen_rank != null ? "Rank " + r.chosen_rank : '<span class="no-data">-</span>'}
        ${rankDetail ? `<div class="rank-detail">${rankDetail}</div>` : ""}
      </td>
      <td class="number">${fmt(r.volume_48h)}</td>
      <td class="number">${fmt(r.plat_per_standing, 6)}</td>
      <td class="number ${scoreClass(r.score)}">${fmt(r.score, 6)}</td>
      <td><a href="${r.market_url}" target="_blank" rel="noopener" style="color:var(--accent2);text-decoration:none;font-size:12px;">Open</a></td>
    </tr>`;
  }

  html += "</tbody></table>";
  content.innerHTML = html;
}

function sortBy(key) {
  if (sortKey === key) {
    sortAsc = !sortAsc;
  } else {
    sortKey = key;
    sortAsc = key === "name";
  }
  renderTable();
}

function exportCSV() {
  if (allResults.length === 0) {
    alert("No data to export.");
    return;
  }

  const filtered = getFiltered();
  const headers = ["Name", "Standing", "Syndicates", "Price (P)", "Rank", "Volume 48h", "P/Standing", "Score", "URL"];
  const rows = filtered.map((r) => [
    `"${r.name}"`,
    r.standing_cost,
    `"${r.syndicates.join(", ")}"`,
    r.chosen_price ?? "",
    r.chosen_rank ?? "",
    r.volume_48h ?? "",
    r.plat_per_standing != null ? r.plat_per_standing.toFixed(6) : "",
    r.score != null ? r.score.toFixed(6) : "",
    r.market_url,
  ]);

  let csv = headers.join(",") + "\n";
  for (const row of rows) csv += row.join(",") + "\n";

  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "warframe_mods_analysis.csv";
  a.click();
}

loadData();
