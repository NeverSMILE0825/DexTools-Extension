const EXT_SOURCE = "twl";

function cleanUnlabeled(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const name of Object.keys(value)) {
    const item = value[name];
    if (!item || typeof item !== "object") continue;
    const eth = Number(item.eth);
    const buys = Number(item.buys);
    const sells = Number(item.sells);
    const buyCount = Number.isFinite(buys) ? buys : 0;
    const sellCount = Number.isFinite(sells) ? sells : 0;
    const count = Number(item.count);
    const buyEth = Number(item.buyEth);
    const sellEth = Number(item.sellEth);
    out[name] = {
      eth: Number.isFinite(eth) ? eth : 0,
      buyEth: Number.isFinite(buyEth) ? buyEth : 0,
      sellEth: Number.isFinite(sellEth) ? sellEth : 0,
      buys: buyCount,
      sells: sellCount,
      count: Number.isFinite(count) ? count : buyCount + sellCount
    };
  }
  return out;
}

function publishLabels() {
  chrome.storage.local.get({ labels: [] }, (data) => {
    const labels = Array.isArray(data.labels) ? data.labels : [];
    window.postMessage({ source: EXT_SOURCE, type: "labels", labels }, "*");
  });
}

function publishSettings() {
  chrome.storage.local.get({ twlShowSum: false, twlShowTable: false }, (data) => {
    window.postMessage(
      {
        source: EXT_SOURCE,
        type: "settings",
        showSum: Boolean(data.twlShowSum),
        showTable: Boolean(data.twlShowTable)
      },
      "*"
    );
  });
}

function statsRank(complete, indexed) {
  return (complete ? 2 : 0) * 1000000000 + (Number(indexed) || 0);
}

function takeStats(prev, next) {
  if (!prev || prev.pair !== next.pair || (prev.chain || "") !== (next.chain || "")) return true;
  const prevRank = statsRank(prev.complete, prev.indexed);
  const nextRank = statsRank(next.complete, next.indexed);
  if (nextRank !== prevRank) return nextRank > prevRank;
  return (Number(next.statsAt) || 0) >= (Number(prev.statsAt) || 0);
}

function publishQuote(quote) {
  if (!quote || typeof quote.key !== "string") return;
  window.postMessage(
    {
      source: EXT_SOURCE,
      type: "quote",
      key: quote.key,
      pair: quote.pair,
      chain: quote.chain,
      pooledEth: quote.pooledEth,
      pooledAt: quote.pooledAt,
      gasGwei: quote.gasGwei,
      gasAt: quote.gasAt
    },
    "*"
  );
}

function publishStatsSync(stats) {
  if (!stats || typeof stats.pair !== "string") return;
  window.postMessage(
    {
      source: EXT_SOURCE,
      type: "stats-sync",
      pair: stats.pair,
      chain: stats.chain || "",
      page: stats.page || "",
      indexed: stats.indexed,
      complete: stats.complete,
      statsAt: stats.statsAt,
      unlabeled: stats.unlabeled
    },
    "*"
  );
}

let quoteMem = null;
let statsMem = null;

function rememberQuote(quote) {
  if (!quote || typeof quote.key !== "string") return null;
  const sameKey = quoteMem && quoteMem.key === quote.key;
  const next = {
    key: quote.key,
    pair: quote.pair || (sameKey ? quoteMem.pair : ""),
    chain: quote.chain || (sameKey ? quoteMem.chain : ""),
    pooledEth: sameKey ? quoteMem.pooledEth : null,
    pooledAt: sameKey ? Number(quoteMem.pooledAt) || 0 : 0,
    gasGwei: sameKey ? quoteMem.gasGwei : null,
    gasAt: sameKey ? Number(quoteMem.gasAt) || 0 : 0
  };
  if (typeof quote.pooledEth === "number" && Number(quote.pooledAt) >= next.pooledAt) {
    next.pooledEth = quote.pooledEth;
    next.pooledAt = Number(quote.pooledAt);
  }
  if (typeof quote.gasGwei === "number" && Number(quote.gasAt) >= next.gasAt) {
    next.gasGwei = quote.gasGwei;
    next.gasAt = Number(quote.gasAt);
  }
  quoteMem = next;
  return next;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.labels) publishLabels();
  if (changes.twlShowSum || changes.twlShowTable) publishSettings();
  if (changes.twlQuote) {
    rememberQuote(changes.twlQuote.newValue);
    publishQuote(quoteMem);
  }
  if (changes.twlStats) {
    const incoming = changes.twlStats.newValue;
    if (takeStats(statsMem, incoming)) statsMem = incoming;
    publishStatsSync(statsMem);
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "twl-page") return;
  if (data.type === "request-labels") {
    publishLabels();
    publishSettings();
    publishQuote(quoteMem);
    publishStatsSync(statsMem);
    return;
  }
  if (data.type === "hide-sum") {
    chrome.storage.local.set({ twlShowSum: false });
    return;
  }
  if (data.type === "show-table") {
    chrome.storage.local.set({ twlShowTable: Boolean(data.showTable) });
    return;
  }
  if (data.type === "quote" && typeof data.key === "string") {
    const next = rememberQuote(data);
    chrome.storage.local.set({ twlQuote: next });
    return;
  }
  if (data.type !== "stats" || typeof data.pair !== "string") return;
  const nextStats = {
    pair: data.pair,
    chain: data.chain || "",
    page: typeof data.page === "string" ? data.page : "",
    matched: Number(data.matched) || 0,
    indexed: Number(data.indexed) || 0,
    complete: Boolean(data.complete),
    statsAt: Number(data.statsAt) || Date.now(),
    byName: data.byName && typeof data.byName === "object" ? data.byName : {},
    unlabeled: cleanUnlabeled(data.unlabeled),
    updatedAt: Date.now()
  };
  if (!takeStats(statsMem, nextStats)) return;
  statsMem = nextStats;
  chrome.storage.local.set({ twlStats: nextStats });
});

publishLabels();
publishSettings();
chrome.storage.local.get({ twlQuote: null, twlStats: null }, (stored) => {
  if (stored.twlQuote) rememberQuote(stored.twlQuote);
  if (takeStats(statsMem, stored.twlStats)) statsMem = stored.twlStats;
  else if (statsMem) chrome.storage.local.set({ twlStats: statsMem });
  publishQuote(quoteMem);
  publishStatsSync(statsMem);
});
