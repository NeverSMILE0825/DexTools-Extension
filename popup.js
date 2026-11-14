const ADDR = /^0x[a-fA-F0-9]{40}$/;
const STORAGE_KEY = "twl-labels";

const TRENDS = ["5m", "1h", "6h", "24h"];
const CHAINS = ["ether", "bsc", "polygon", "base", "arbitrum"];
const ASSET_ID = /^0x[a-fA-F0-9]{40,}(?:-\d+)*$/;

const tokenNameInput = document.getElementById("tokenName");
const tokenTickerInput = document.getElementById("tokenTicker");
const tokenCaInput = document.getElementById("tokenCa");
const tokenPairInput = document.getElementById("tokenPair");
const tokenBaseInput = document.getElementById("tokenBase");
const tokenChainInput = document.getElementById("tokenChain");
const tokenTrendBox = document.getElementById("tokenTrend");
const tokenMessage = document.getElementById("tokenMessage");

const labelNameInput = document.getElementById("labelName");
const addressesInput = document.getElementById("addresses");
const addressCount = document.getElementById("addressCount");
const formMessage = document.getElementById("formMessage");
const savedList = document.getElementById("savedList");
const savedSummary = document.getElementById("savedSummary");
const showSumInput = document.getElementById("showSum");
const statusLine = document.getElementById("status");

let labels = [];
let editingId = null;
let tokenTrend = "24h";
let stats = null;
let activePair = "";
let activeUrl = "";

function hasExtensionStorage() {
  return Boolean(globalThis.chrome && chrome.storage && chrome.storage.local);
}

function parseAddresses(text) {
  const parts = String(text || "")
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const valid = [];
  const seen = new Set();
  let invalid = 0;
  for (const part of parts) {
    if (!ADDR.test(part)) {
      invalid += 1;
      continue;
    }
    const address = part.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    valid.push(address);
  }
  return { valid, invalid };
}

function plural(count, noun) {
  const plurals = { address: "addresses", entry: "entries", trade: "trades" };
  const word = count === 1 ? noun : plurals[noun] || noun + "s";
  return count + " " + word;
}

function pairFromUrl(url) {
  const match = String(url || "").match(/pair-explorer\/(0x[a-fA-F0-9]{40,})/i);
  return match ? match[1].toLowerCase() : "";
}

function pagePath(url) {
  try {
    return new URL(url).pathname;
  } catch (error) {
    return "";
  }
}

function isTokenPage(url) {
  return /dextools\.io\/app\/(?:[^/]+\/)?token\//i.test(String(url || ""));
}

function resolveActivePair() {
  const fromUrl = pairFromUrl(activeUrl);
  if (fromUrl) return fromUrl;
  const path = pagePath(activeUrl);
  if (isTokenPage(activeUrl) && stats && stats.page === path && stats.pair) return String(stats.pair).toLowerCase();
  return "";
}

function applyActivePair() {
  const nextPair = resolveActivePair();
  if (nextPair === activePair) return false;
  activePair = nextPair;
  return true;
}

function tradeCount(name) {
  if (!stats || !stats.complete || !activePair || stats.pair !== activePair) return null;
  const value = stats.byName && stats.byName[name];
  return typeof value === "number" ? value : 0;
}

function formatEth(value) {
  if (!Number.isFinite(value) || value === 0) return "0";
  const sign = value > 0 ? "+" : "-";
  const abs = Math.abs(value);
  const digits = abs < 0.000001 ? 10 : 6;
  const text = abs.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return sign + text;
}

function unlabeledOf(name) {
  if (!stats || !activePair || stats.pair !== activePair) return null;
  if (!stats.complete && !stats.indexed) return null;
  const value = stats.unlabeled && stats.unlabeled[name];
  const eth = value && typeof value.eth === "number" ? value.eth : 0;
  const buys = value && typeof value.buys === "number" ? value.buys : 0;
  const sells = value && typeof value.sells === "number" ? value.sells : 0;
  const count = value && typeof value.count === "number" ? value.count : buys + sells;
  return { eth, count, buys, sells, complete: Boolean(stats.complete) };
}

function unlabeledText(info) {
  return (
    plural(info.count, "trade") +
    " · " +
    plural(info.buys, "buy") +
    " · " +
    plural(info.sells, "sell") +
    " · " +
    formatEth(info.eth) +
    " ETH" +
    (info.complete ? "" : " · counting")
  );
}

function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

async function loadLabels() {
  if (hasExtensionStorage()) {
    const data = await chrome.storage.local.get({ labels: [] });
    return Array.isArray(data.labels) ? data.labels : [];
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function saveLabels(next) {
  labels = next;
  if (hasExtensionStorage()) {
    await chrome.storage.local.set({ labels: next });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  renderSaved();
}

function setTokenMessage(text, kind) {
  tokenMessage.textContent = text || "";
  tokenMessage.className = "form-message" + (kind ? " " + kind : "");
}

function selectedTrend() {
  return TRENDS.includes(tokenTrend) ? tokenTrend : "24h";
}

function paintTrend() {
  const buttons = tokenTrendBox.querySelectorAll("button");
  for (const button of buttons) button.classList.toggle("on", button.dataset.trend === selectedTrend());
}

function readTokenForm() {
  const name = tokenNameInput.value;
  const ticker = tokenTickerInput.value;
  const ca = tokenCaInput.value.trim();
  const pair = tokenPairInput.value.trim();
  const base = tokenBaseInput.value.trim();
  const chain = CHAINS.includes(tokenChainInput.value) ? tokenChainInput.value : "ether";
  return { name, ticker, ca, pair, base, chain, trend: selectedTrend() };
}

function applyTokenForm(token) {
  tokenNameInput.value = token && typeof token.name === "string" ? token.name : "";
  tokenTickerInput.value = token && typeof token.ticker === "string" ? token.ticker : "";
  tokenCaInput.value = token && typeof token.ca === "string" ? token.ca : "";
  tokenPairInput.value = token && typeof token.pair === "string" ? token.pair : "";
  tokenBaseInput.value = token && typeof token.base === "string" ? token.base : "";
  tokenChainInput.value = token && CHAINS.includes(token.chain) ? token.chain : "ether";
  tokenTrend = token && TRENDS.includes(token.trend) ? token.trend : "24h";
  paintTrend();
}

async function saveToken(trendOnly) {
  const token = readTokenForm();
  if (!token.name.trim()) {
    setTokenMessage("Enter the token name.", "err");
    tokenNameInput.focus();
    return;
  }
  if (!token.ticker.trim()) {
    setTokenMessage("Enter the token ticker.", "err");
    tokenTickerInput.focus();
    return;
  }
  if (token.ca && !ASSET_ID.test(token.ca)) {
    setTokenMessage("CA must be a full 0x address.", "err");
    tokenCaInput.focus();
    return;
  }
  if (token.pair && !ASSET_ID.test(token.pair)) {
    setTokenMessage("Pair address must be a full 0x pair id.", "err");
    tokenPairInput.focus();
    return;
  }
  const next = {
    name: token.name,
    ticker: token.ticker,
    ca: token.ca.toLowerCase(),
    pair: token.pair.toLowerCase(),
    base: token.base,
    chain: token.chain,
    trend: token.trend,
    updatedAt: Date.now()
  };
  if (hasExtensionStorage()) await chrome.storage.local.set({ twlToken: next });
  else localStorage.setItem("twl-token", JSON.stringify(next));
  setTokenMessage(trendOnly ? "Trending window saved." : "Saved " + token.ticker.trim() + ".", "ok");
}

function setMessage(text, kind) {
  formMessage.textContent = text || "";
  formMessage.className = "form-message" + (kind ? " " + kind : "");
}

function updateCount() {
  const parsed = parseAddresses(addressesInput.value);
  addressCount.textContent = plural(parsed.valid.length, "address");
}

function renderSaved() {
  const wallets = labels.reduce((sum, label) => sum + (label.addresses ? label.addresses.length : 0), 0);
  const visible = labels.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const counting = Boolean(stats && !stats.complete && activePair && stats.pair === activePair);
  const matched = stats && stats.complete && activePair && stats.pair === activePair ? stats.matched : null;
  const breakdown = visible
    .map((label) => {
      const trades = tradeCount(label.name);
      const unlabeled = unlabeledOf(label.name);
      const net = unlabeled ? ", unlabeled " + unlabeledText(unlabeled) : "";
      if (typeof trades === "number") return label.name + " (" + plural(trades, "trade") + net + ")";
      if (unlabeled) return label.name + " (unlabeled " + unlabeledText(unlabeled) + ")";
      return label.name + " (" + plural(label.addresses.length, "address") + ")";
    })
    .join(" · ");
  savedSummary.textContent =
    plural(labels.length, "label") +
    " · " +
    plural(wallets, "address") +
    (typeof matched === "number" ? " · " + plural(matched, "trade") + " on this pair" : "") +
    (counting ? " · counting trades" : "") +
    (breakdown ? " · " + breakdown : "");
  savedList.textContent = "";
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No saved labels yet.";
    savedList.appendChild(empty);
    return;
  }
  for (const label of visible) {
    const row = document.createElement("div");
    row.className = "saved-item";

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = label.name;
    pill.title = label.name;

    const count = document.createElement("span");
    count.className = "wallet-count";
    const trades = tradeCount(label.name);
    count.textContent =
      plural(label.addresses.length, "address") +
      (typeof trades === "number" ? " · " + plural(trades, "trade") : "");

    const unlabeled = unlabeledOf(label.name);
    let sum = null;
    if (unlabeled) {
      sum = document.createElement("span");
      const tone = unlabeled.eth < 0 ? " neg" : unlabeled.eth > 0 ? " pos" : "";
      sum.className = "unlabeled-sum" + tone;
      sum.textContent = "Unlabeled " + unlabeledText(unlabeled);
      sum.title =
        unlabeled.buys +
        " buys and " +
        unlabeled.sells +
        " sells not labeled " +
        label.name +
        ". Buys add Total ETH. Sells subtract Total ETH.";
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => startEdit(label.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => removeLabel(label.id));

    row.append(pill, count, edit, remove);
    if (sum) row.append(sum);
    savedList.appendChild(row);
  }
}

function startEdit(id) {
  const label = labels.find((item) => item.id === id);
  if (!label) return;
  editingId = id;
  labelNameInput.value = label.name;
  addressesInput.value = label.addresses.join("\n");
  updateCount();
  setMessage("Editing " + label.name + ". Save replaces this list.", "ok");
  labelNameInput.focus();
}

async function removeLabel(id) {
  const label = labels.find((item) => item.id === id);
  if (!label) return;
  const ok = confirm("Delete the " + label.name + " label and its " + plural(label.addresses.length, "wallet") + "?");
  if (!ok) return;
  await saveLabels(labels.filter((item) => item.id !== id));
  if (editingId === id) clearForm();
}

function clearForm() {
  editingId = null;
  labelNameInput.value = "";
  addressesInput.value = "";
  updateCount();
  setMessage("");
}

async function saveForm() {
  const name = labelNameInput.value;
  const parsed = parseAddresses(addressesInput.value);
  if (!name) {
    setMessage("Enter a label name.", "err");
    labelNameInput.focus();
    return;
  }
  if (!parsed.valid.length) {
    setMessage("Paste at least one full 0x address.", "err");
    addressesInput.focus();
    return;
  }

  const next = labels.map((label) => ({ ...label, addresses: label.addresses.slice() }));
  const sameName = next.find((label) => label.name.toLowerCase() === name.toLowerCase());
  let target = editingId ? next.find((label) => label.id === editingId) : null;

  if (target && sameName && sameName.id !== target.id) {
    const merged = new Set(sameName.addresses.concat(parsed.valid));
    sameName.addresses = [...merged];
    sameName.name = name;
    sameName.updatedAt = Date.now();
    const removeId = target.id;
    await saveLabels(next.filter((label) => label.id !== removeId));
  } else if (target) {
    target.name = name;
    target.addresses = parsed.valid;
    target.updatedAt = Date.now();
    await saveLabels(next);
  } else if (sameName) {
    const merged = new Set(sameName.addresses.concat(parsed.valid));
    sameName.addresses = [...merged];
    sameName.name = name;
    sameName.updatedAt = Date.now();
    await saveLabels(next);
  } else {
    next.push({
      id: uid(),
      name,
      addresses: parsed.valid,
      updatedAt: Date.now()
    });
    await saveLabels(next);
  }

  const skipped =
    parsed.invalid > 0
      ? " Skipped " + plural(parsed.invalid, "entry") + " that " + (parsed.invalid === 1 ? "is" : "are") + " not a full address."
      : "";
  clearForm();
  setMessage("Saved " + name + " · " + plural(parsed.valid.length, "wallet") + "." + skipped, "ok");
}

async function refreshStatus() {
  try {
    if (!globalThis.chrome || !chrome.tabs || !chrome.tabs.query) return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeUrl = tabs[0] && tabs[0].url ? tabs[0].url : "";
    if (applyActivePair()) renderSaved();
    if (/dextools\.io\/app\/[^/]+\/pair-explorer\//i.test(activeUrl) || isTokenPage(activeUrl)) {
      statusLine.textContent = "Watching this DEXTools page.";
      statusLine.classList.add("ok");
    } else if (/dextools\.io/i.test(activeUrl)) {
      statusLine.textContent = "Open a pair or token page to label makers.";
      statusLine.classList.remove("ok");
    } else {
      statusLine.textContent = "Open a DEXTools pair or token page.";
      statusLine.classList.remove("ok");
    }
  } catch (error) {
    statusLine.textContent = "Open a DEXTools pair or token page.";
  }
}

labelNameInput.addEventListener("input", () => setMessage(""));
addressesInput.addEventListener("input", () => {
  updateCount();
  setMessage("");
});
tokenTrendBox.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || !TRENDS.includes(button.dataset.trend)) return;
  tokenTrend = button.dataset.trend;
  paintTrend();
  const draft = readTokenForm();
  if (draft.name.trim() && draft.ticker.trim()) saveToken(true);
});
document.getElementById("saveToken").addEventListener("click", () => saveToken(false));
document.getElementById("save").addEventListener("click", saveForm);
document.getElementById("clear").addEventListener("click", clearForm);
showSumInput.addEventListener("change", () => {
  const showSum = showSumInput.checked;
  if (hasExtensionStorage()) chrome.storage.local.set({ twlShowSum: showSum });
  else localStorage.setItem("twl-show-sum", showSum ? "1" : "0");
});
addressesInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") saveForm();
});

paintTrend();
loadLabels().then((stored) => {
  labels = stored;
  renderSaved();
  updateCount();
});
if (hasExtensionStorage()) {
  chrome.storage.local.get({ twlToken: null }, (data) => applyTokenForm(data.twlToken));
} else {
  try {
    applyTokenForm(JSON.parse(localStorage.getItem("twl-token") || "null"));
  } catch (error) {
    applyTokenForm(null);
  }
}
if (hasExtensionStorage()) {
  chrome.storage.local.get({ twlShowSum: false }, (data) => {
    showSumInput.checked = Boolean(data.twlShowSum);
  });
} else {
  showSumInput.checked = localStorage.getItem("twl-show-sum") === "1";
}
if (hasExtensionStorage()) {
  chrome.storage.local.get({ twlStats: null }, (data) => {
    stats = data.twlStats || null;
    applyActivePair();
    renderSaved();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.twlShowSum) showSumInput.checked = Boolean(changes.twlShowSum.newValue);
    if (changes.twlStats) {
      stats = changes.twlStats.newValue || null;
      applyActivePair();
      renderSaved();
    }
  });
}
refreshStatus();
