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
    out[name] = {
      eth: Number.isFinite(eth) ? eth : 0,
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
  chrome.storage.local.get({ twlShowSum: false }, (data) => {
    window.postMessage({ source: EXT_SOURCE, type: "settings", showSum: Boolean(data.twlShowSum) }, "*");
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.labels) publishLabels();
  if (changes.twlShowSum) publishSettings();
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "twl-page") return;
  if (data.type === "request-labels") {
    publishLabels();
    publishSettings();
    return;
  }
  if (data.type === "hide-sum") {
    chrome.storage.local.set({ twlShowSum: false });
    return;
  }
  if (data.type !== "stats" || typeof data.pair !== "string") return;
  chrome.storage.local.set({
    twlStats: {
      pair: data.pair,
      chain: data.chain || "",
      page: typeof data.page === "string" ? data.page : "",
      matched: Number(data.matched) || 0,
      indexed: Number(data.indexed) || 0,
      complete: Boolean(data.complete),
      byName: data.byName && typeof data.byName === "object" ? data.byName : {},
      unlabeled: cleanUnlabeled(data.unlabeled),
      updatedAt: Date.now()
    }
  });
});

publishLabels();
publishSettings();
