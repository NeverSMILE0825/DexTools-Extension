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

function cleanBot(value) {
  if (!value || typeof value !== "object") return null;
  const eth = Number(value.eth);
  const buyEth = Number(value.buyEth);
  const sellEth = Number(value.sellEth);
  const buys = Number(value.buys);
  const sells = Number(value.sells);
  const buyCount = Number.isFinite(buys) ? buys : 0;
  const sellCount = Number.isFinite(sells) ? sells : 0;
  const count = Number(value.count);
  return {
    eth: Number.isFinite(eth) ? eth : 0,
    buyEth: Number.isFinite(buyEth) ? buyEth : 0,
    sellEth: Number.isFinite(sellEth) ? sellEth : 0,
    buys: buyCount,
    sells: sellCount,
    count: Number.isFinite(count) ? count : buyCount + sellCount
  };
}

function publishLabels() {
  chrome.storage.local.get({ labels: [] }, (data) => {
    const labels = Array.isArray(data.labels) ? data.labels : [];
    window.postMessage({ source: EXT_SOURCE, type: "labels", labels }, "*");
  });
}

function cleanToken(value) {
  if (!value || typeof value.name !== "string" || typeof value.ticker !== "string") return null;
  if (!value.name.trim() || !value.ticker.trim()) return null;
  const trends = ["5m", "1h", "6h", "24h"];
  const chains = ["ether", "bsc", "polygon", "base", "arbitrum"];
  return {
    name: value.name,
    ticker: value.ticker,
    ca: typeof value.ca === "string" ? value.ca.toLowerCase() : "",
    pair: typeof value.pair === "string" ? value.pair.toLowerCase() : "",
    base: typeof value.base === "string" ? value.base : "",
    chain: chains.includes(value.chain) ? value.chain : "ether",
    trend: trends.includes(value.trend) ? value.trend : "24h"
  };
}

function cleanRank(value) {
  if (typeof value === "number" && value > 0) return value;
  return null;
}

function cleanDir(value) {
  return value === "up" || value === "down" ? value : "";
}

function cleanRanks(value) {
  if (!value || typeof value.tokenKey !== "string") return null;
  const trends = ["5m", "1h", "6h", "24h"];
  const trend = trends.includes(value.trend) ? value.trend : "24h";
  const trendRanks = {};
  const trendDirs = {};
  const sourceRanks = value.trendRanks && typeof value.trendRanks === "object" ? value.trendRanks : {};
  const sourceDirs = value.trendDirs && typeof value.trendDirs === "object" ? value.trendDirs : {};
  for (const item of trends) {
    trendRanks[item] = cleanRank(sourceRanks[item]);
    trendDirs[item] = cleanDir(sourceDirs[item]);
  }
  return {
    tokenKey: value.tokenKey,
    trend,
    at: Number(value.at) || 0,
    hot: cleanRank(value.hot),
    hotDir: cleanDir(value.hotDir),
    nitro: cleanRank(value.nitro),
    nitroDir: cleanDir(value.nitroDir),
    updates: cleanRank(value.updates),
    updatesDir: cleanDir(value.updatesDir),
    trendRanks,
    trendDirs
  };
}

function publishToken() {
  chrome.storage.local.get({ twlToken: null }, (data) => {
    window.postMessage({ source: EXT_SOURCE, type: "token", token: cleanToken(data.twlToken) }, "*");
  });
}

function publishRanks(ranks) {
  const next = cleanRanks(ranks);
  if (!next) return;
  window.postMessage({ source: EXT_SOURCE, type: "ranks", ranks: next }, "*");
}

function publishSettings() {
  chrome.storage.local.get(
    { twlShowSum: false, twlShowBot: true, twlShowTable: false, twlShowBotTable: false, twlShowRanks: true },
    (data) => {
      window.postMessage(
        {
          source: EXT_SOURCE,
          type: "settings",
          showSum: Boolean(data.twlShowSum),
          showBot: data.twlShowBot !== false,
          showTable: Boolean(data.twlShowTable),
          showBotTable: Boolean(data.twlShowBotTable),
          showRanks: Boolean(data.twlShowRanks)
        },
        "*"
      );
    }
  );
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
      unlabeled: stats.unlabeled,
      bot: cleanBot(stats.bot)
    },
    "*"
  );
}

let quoteMem = null;
let statsMem = null;
let ranksMem = null;

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
  if (changes.twlToken) publishToken();
  if (changes.twlRanks) {
    const incoming = cleanRanks(changes.twlRanks.newValue);
    if (incoming && (!ranksMem || incoming.at >= ranksMem.at)) ranksMem = incoming;
    publishRanks(ranksMem);
  }
  if (changes.twlShowSum || changes.twlShowBot || changes.twlShowTable || changes.twlShowBotTable || changes.twlShowRanks) publishSettings();
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
    publishToken();
    publishQuote(quoteMem);
    publishStatsSync(statsMem);
    publishRanks(ranksMem);
    return;
  }
  if (data.type === "ranks" && data.ranks) {
    const incoming = cleanRanks(data.ranks);
    if (!incoming || (ranksMem && incoming.tokenKey === ranksMem.tokenKey && incoming.at <= ranksMem.at)) return;
    ranksMem = incoming;
    chrome.storage.local.set({ twlRanks: incoming });
    return;
  }
  if (data.type === "hide-sum") {
    chrome.storage.local.set({ twlShowSum: false });
    return;
  }
  if (data.type === "hide-bot") {
    chrome.storage.local.set({ twlShowBot: false });
    return;
  }
  if (data.type === "show-table") {
    chrome.storage.local.set({ twlShowTable: Boolean(data.showTable) });
    return;
  }
  if (data.type === "show-bot-table") {
    chrome.storage.local.set({ twlShowBotTable: Boolean(data.showBotTable) });
    return;
  }
  if (data.type === "show-ranks") {
    chrome.storage.local.set({ twlShowRanks: Boolean(data.showRanks) });
    return;
  }
  if (data.type === "unlabeled-trade" && typeof data.id === "string") {
    chrome.runtime.sendMessage(
      {
        type: "unlabeled-trade",
        id: data.id,
        tradeType: data.tradeType === "sell" ? "sell" : "buy",
        time: typeof data.time === "string" ? data.time : "",
        amount: typeof data.amount === "string" ? data.amount : "",
        maker: typeof data.maker === "string" ? data.maker : ""
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
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
    bot: cleanBot(data.bot),
    updatedAt: Date.now()
  };
  if (!takeStats(statsMem, nextStats)) return;
  statsMem = nextStats;
  chrome.storage.local.set({ twlStats: nextStats });
});

publishLabels();
publishSettings();
publishToken();
chrome.storage.local.get({ twlQuote: null, twlStats: null, twlRanks: null }, (stored) => {
  if (stored.twlQuote) rememberQuote(stored.twlQuote);
  if (takeStats(statsMem, stored.twlStats)) statsMem = stored.twlStats;
  else if (statsMem) chrome.storage.local.set({ twlStats: statsMem });
  ranksMem = cleanRanks(stored.twlRanks);
  publishQuote(quoteMem);
  publishStatsSync(statsMem);
  publishRanks(ranksMem);
});
