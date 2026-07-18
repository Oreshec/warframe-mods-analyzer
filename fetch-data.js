const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.warframe.market/v1";
const FANDOM_API = "https://warframe.fandom.com/api.php";

const SYNDICATE_PAGES = [
  ["Steel_Meridian", "Steel Meridian"],
  ["Arbiters_of_Hexis", "Arbiters of Hexis"],
  ["Cephalon_Suda", "Cephalon Suda"],
  ["The_Perrin_Sequence", "The Perrin Sequence"],
  ["Red_Veil", "Red Veil"],
  ["New_Loka", "New Loka"],
];

function deriveUrlName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]+/g, "");
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
    console.log(`Wiki: ${synName}...`);
    try {
      const resp = await fetch(`${FANDOM_API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`);
      const data = await resp.json();
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
      console.error(`  Failed: ${err.message}`);
    }
  }
  return Object.values(combined);
}

async function fetchStatistics48h(urlName, platform) {
  try {
    const resp = await fetch(`${API_BASE}/items/${urlName}/statistics?platform=${platform}`, { timeout: 25000 });
    const data = await resp.json();
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
    const resp = await fetch(`${API_BASE}/items/${urlName}/orders?platform=${platform}`, { timeout: 25000 });
    const data = await resp.json();
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

async function main() {
  const platform = process.argv[2] || "pc";
  console.log(`Fetching syndicate mods from wiki (platform: ${platform})...`);
  const mods = await fetchSyndicateMods();
  console.log(`Found ${mods.length} mods. Fetching market data...`);

  const results = [];
  const CONCURRENCY = 4;
  let i = 0;

  async function worker() {
    while (i < mods.length) {
      const idx = i++;
      process.stdout.write(`  ${idx + 1}/${mods.length} ${mods[idx].url_name}...`);
      try {
        const r = await fetchOneMod(mods[idx], platform);
        results.push(r);
        console.log(` OK (score: ${r.score != null ? r.score.toFixed(6) : "n/a"})`);
      } catch (err) {
        console.log(` FAIL: ${err.message}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, mods.length); w++) workers.push(worker());
  await Promise.all(workers);

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const output = { platform, updated_at: new Date().toISOString(), results };
  const outPath = path.join(__dirname, "data", "results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\nWrote ${results.length} results to data/results.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
