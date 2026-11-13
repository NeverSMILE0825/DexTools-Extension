(() => {
  if (window.__twlInstalled) return;
  window.__twlInstalled = true;

  const ADDR = /^0x[a-fA-F0-9]{40}$/;
  const TX = /^0x[a-fA-F0-9]{64}$/;
  const txToMaker = new Map();
  const trades = new Map();
  let addressToLabel = new Map();
  let tailIndex = new Map();
  let labelOrder = [];
  let showSum = false;
  let showTable = false;
  let lastUnlabeled = {};
  let lastComplete = false;
  let pooledEth = null;
  let pooledFor = "";
  let gasGwei = null;
  let gasFor = "";
  let tokenSupply = null;
  let supplyFor = "";
  let tradeHeaders = ["Date", "Type", "MCap", "Price ETH", "Total ETH", "GTA", "Maker", "Others"];
  let localPoolAt = 0;
  let localGasAt = 0;
  let localStatsAt = 0;
  let remoteStats = null;
  let scanTimer = 0;
  let scanning = false;

  function isAddr(value) {
    return typeof value === "string" && ADDR.test(value);
  }

  function isTx(value) {
    return typeof value === "string" && TX.test(value);
  }

  function schedule() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 80);
  }

  function remember(tx, maker) {
    const key = tx.toLowerCase();
    const value = maker.toLowerCase();
    if (txToMaker.get(key) === value) return false;
    txToMaker.set(key, value);
    if (txToMaker.size > 20000) {
      const drop = txToMaker.size - 15000;
      let removed = 0;
      for (const id of txToMaker.keys()) {
        txToMaker.delete(id);
        if (++removed >= drop) break;
      }
    }
    return true;
  }

  function rememberTrade(item) {
    if ((item.type !== "buy" && item.type !== "sell") || item.amount == null) return false;
    const tx = item.id.toLowerCase();
    const maker = item.maker.toLowerCase();
    const key =
      item.blockNumber != null && item.logIndex != null
        ? tx + ":" + item.blockNumber + ":" + item.logIndex
        : tx + ":" + item.type + ":" + item.amount;
    const prev = trades.get(key);
    const next = {
      maker,
      type: item.type,
      amount: item.amount,
      timestamp: item.timestamp || 0,
      price: item.price,
      priceETH: item.priceETH,
      amountUSD: item.amountUSD,
      amountToken: item.amountToken,
      id: tx
    };
    if (
      prev &&
      prev.maker === maker &&
      prev.type === next.type &&
      prev.amount === next.amount &&
      prev.timestamp === next.timestamp &&
      prev.price === next.price &&
      prev.amountToken === next.amountToken
    ) {
      return false;
    }
    trades.set(key, next);
    if (!prev) notifyUnlabeled(next);
    return true;
  }

  function armNotifications() {
    notifyReady = indexComplete && labelsReady;
  }

  function notifyUnlabeled(trade) {
    if (!notifyReady || !addressToLabel.size || addressToLabel.has(trade.maker)) return;
    window.postMessage(
      {
        source: "twl-page",
        type: "unlabeled-trade",
        id: trade.id,
        tradeType: trade.type,
        time: formatTradeDate(trade.timestamp) || "Just now",
        amount: formatAmount(trade.amount),
        maker: trade.maker
      },
      "*"
    );
  }

  function collect(value, found, depth, seen) {
    if (!value || typeof value !== "object" || depth > 7 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collect(item, found, depth + 1, seen);
      return;
    }
    let maker = value.maker || value.makerAddress || value.wallet;
    if (maker && typeof maker === "object") maker = maker.address || maker.wallet;
    const id = value.id || value.hash || value.txHash || value.transactionHash;
    if (isAddr(maker) && isTx(id)) {
      const type = String(value.type || "").toLowerCase();
      const raw = value.amountETH != null ? value.amountETH : value.amountRef;
      const amount = Math.abs(Number(raw));
      const num = (field) => {
        const parsed = Number(value[field]);
        return Number.isFinite(parsed) ? parsed : null;
      };
      found.push({
        id,
        maker,
        type,
        amount: Number.isFinite(amount) ? amount : null,
        blockNumber: value.blockNumber,
        logIndex: value.logIndex,
        timestamp: Number(value.timestamp) || 0,
        price: num("price"),
        priceETH: num("priceETH"),
        amountUSD: num("amountUSD"),
        amountToken: num("amountToken")
      });
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === "object") collect(child, found, depth + 1, seen);
    }
  }

  function ingestText(text) {
    if (!text || typeof text !== "string" || text.length > 4000000) return;
    if (text.indexOf("maker") === -1 && text.indexOf("0x") === -1) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return;
    }
    const found = [];
    collect(data, found, 0, new Set());
    let changed = false;
    for (const item of found) {
      if (remember(item.id, item.maker)) changed = true;
      if (rememberTrade(item)) changed = true;
    }
    if (changed) {
      schedule();
      queueStats();
    }
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isTradeFeed(url) {
    return (
      url.indexOf("/pool/events/") !== -1 ||
      url.indexOf("/transactions") !== -1 ||
      url.indexOf("/makers") !== -1 ||
      url.indexOf("/swaps") !== -1
    );
  }

  let nativeFetch = null;

  function hookFetch() {
    const native = window.fetch;
    if (!native || native.__twl) return;
    nativeFetch = native;
    const wrapped = function (input, init) {
      return native.call(this, input, init).then((response) => {
        try {
          const url = requestUrl(input);
          if (isTradeFeed(url)) {
            response.clone().text().then(ingestText).catch(() => {});
          }
        } catch (error) {}
        return response;
      });
    };
    wrapped.__twl = true;
    window.fetch = wrapped;
  }

  function hookXhr() {
    const proto = XMLHttpRequest.prototype;
    if (proto.__twl) return;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    proto.open = function (method, url) {
      this.__twlUrl = String(url || "");
      return nativeOpen.apply(this, arguments);
    };
    proto.send = function () {
      this.addEventListener("load", function () {
        try {
          if (!isTradeFeed(String(this.__twlUrl || ""))) return;
          let text = "";
          try {
            text = this.responseText;
          } catch (error) {
            if (this.response && typeof this.response === "object") text = JSON.stringify(this.response);
          }
          ingestText(text);
        } catch (error) {}
      });
      return nativeSend.apply(this, arguments);
    };
    proto.__twl = true;
  }

  function hookWebSocket() {
    const Native = window.WebSocket;
    if (!Native || Native.__twl) return;
    function Wrapped(url, protocols) {
      const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
      socket.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") ingestText(data);
        else if (data instanceof Blob) data.text().then(ingestText).catch(() => {});
      });
      return socket;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
    Wrapped.__twl = true;
    Object.setPrototypeOf(Wrapped, Native);
    window.WebSocket = Wrapped;
  }

  function chainFromExplorer(href) {
    let host = "";
    try {
      host = new URL(href, location.origin).hostname.toLowerCase().replace(/^www\./, "");
    } catch (error) {
      return "";
    }
    const hosts = {
      "etherscan.io": "ether",
      "bscscan.com": "bsc",
      "polygonscan.com": "polygon",
      "basescan.org": "base",
      "arbiscan.io": "arbitrum",
      "snowtrace.io": "avalanche",
      "optimistic.etherscan.io": "optimism",
      "ftmscan.com": "fantom",
      "cronoscan.com": "cronos",
      "gnosisscan.io": "gnosis",
      "lineascan.build": "linea",
      "scrollscan.com": "scroll",
      "blastscan.io": "blast",
      "solscan.io": "solana"
    };
    return hosts[host] || "";
  }

  function chainFromSelector() {
    const el = document.querySelector(".chain-label");
    const text = el ? el.textContent.replace(/\s+/g, " ").trim().toLowerCase() : "";
    const names = {
      ethereum: "ether",
      ether: "ether",
      eth: "ether",
      bnb: "bsc",
      "bnb chain": "bsc",
      binance: "bsc",
      polygon: "polygon",
      base: "base",
      arbitrum: "arbitrum",
      avalanche: "avalanche",
      solana: "solana",
      optimism: "optimism",
      fantom: "fantom"
    };
    return names[text] || "";
  }

  function pairFromDom() {
    const blocks = document.querySelectorAll(".info-address");
    for (const block of blocks) {
      const symbol = block.querySelector(".symbol");
      if (!symbol || !/^\s*pair\s*$/i.test(symbol.textContent || "")) continue;
      const link = block.querySelector("a[href]");
      if (!link) continue;
      const href = link.getAttribute("href") || "";
      const match = href.match(/0x[a-fA-F0-9]{40,}/i);
      if (!match) continue;
      const chain = chainFromExplorer(href) || chainFromSelector();
      if (!chain) continue;
      return { chain, pair: match[0] };
    }
    return null;
  }

  function pairFromChart() {
    const frames = document.querySelectorAll("iframe[data-widget-options], iframe[src]");
    for (const frame of frames) {
      const raw = (frame.getAttribute("data-widget-options") || "") + " " + (frame.getAttribute("src") || "");
      let text = raw;
      try {
        text = decodeURIComponent(raw);
      } catch (error) {
        text = raw;
      }
      const match = text.match(/clientId=(0x[a-fA-F0-9]{40,})-([a-z0-9]+)/i);
      if (!match) continue;
      const slug = match[2].toLowerCase();
      return { chain: slug === "ethereum" ? "ether" : slug, pair: match[1] };
    }
    return null;
  }

  function pairFromLocation() {
    const match = location.pathname.match(/\/app\/([^/]+)\/pair-explorer\/(0x[a-fA-F0-9]{40,})/i);
    if (match) {
      const slug = match[1].toLowerCase();
      const chain = slug === "ethereum" ? "ether" : slug;
      return { chain, pair: match[2] };
    }
    if (/\/app\/(?:[^/]+\/)?token\//i.test(location.pathname)) return pairFromDom() || pairFromChart();
    return null;
  }

  let indexedKey = "";
  let indexToken = 0;
  let indexComplete = false;
  let notifyReady = false;
  let labelsReady = false;
  let statsTimer = 0;

  function queueStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      const info = pairFromLocation();
      if (info) publishStats(info);
    }, 400);
  }

  function roundEth(value) {
    return Math.round(value * 1e12) / 1e12;
  }

  function formatEth(value) {
    if (!Number.isFinite(value) || value === 0) return "0";
    const sign = value > 0 ? "+" : "-";
    const abs = Math.abs(value);
    const digits = abs < 0.000001 ? 10 : 6;
    const text = abs.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
    return sign + text;
  }

  function formatPool(value) {
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    const parts = abs.toFixed(digits).split(".");
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const fraction = (parts[1] || "").replace(/0+$/, "");
    return fraction ? whole + "." + fraction : whole;
  }

  function currentPairKey() {
    const info = pairFromLocation();
    return info ? info.chain + ":" + info.pair.toLowerCase() : "";
  }

  function formatGwei(value) {
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : 3;
    return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "") + " gwei";
  }

  function gasRpcList(chain) {
    const nodes = {
      ether: ["https://ethereum.publicnode.com", "https://eth.drpc.org"],
      bsc: ["https://bsc.publicnode.com"],
      polygon: ["https://polygon-bor.publicnode.com"],
      base: ["https://base.publicnode.com"],
      arbitrum: ["https://arbitrum-one.publicnode.com"]
    };
    return nodes[chain] || [];
  }

  function readGas(chain) {
    const fetchImpl = nativeFetch || window.fetch;
    const urls = gasRpcList(chain);
    const next = (index) => {
      if (index >= urls.length) return Promise.resolve(null);
      return fetchImpl(urls[index], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] })
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!data || typeof data.result !== "string") return next(index + 1);
          const gwei = Number(BigInt(data.result)) / 1e9;
          return Number.isFinite(gwei) ? gwei : next(index + 1);
        })
        .catch(() => next(index + 1));
    };
    return next(0);
  }

  function refreshPooled() {
    const info = pairFromLocation();
    if (!info) return;
    const key = info.chain + ":" + info.pair.toLowerCase();
    const url =
      "https://www.dextools.io/shared/data/pair?address=" +
      encodeURIComponent(info.pair) +
      "&chain=" +
      encodeURIComponent(info.chain);
    const fetchImpl = nativeFetch || window.fetch;
    const poolPromise = fetchImpl(url, { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const row = data && data.data && data.data[0];
        const metrics = row && row.metrics;
        if (!metrics) return null;
        const ref = String(row.symbolRef || "").toUpperCase();
        const sym = String(row.symbol || "").toUpperCase();
        const tokenRef = String((row.id && row.id.tokenRef) || "").toLowerCase();
        const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
        const refIsEth =
          ref === "ETH" ||
          ref === "WETH" ||
          tokenRef === "0x0000000000000000000000000000000000000000" ||
          tokenRef === weth;
        const raw = refIsEth ? metrics.reserveRef : sym === "ETH" || sym === "WETH" ? metrics.reserve : null;
        const value = Number(raw);
        const tokenMetrics = row.token && row.token.metrics;
        const supply = Number(tokenMetrics && (tokenMetrics.circulatingSupply || tokenMetrics.totalSupply));
        if (Number.isFinite(supply) && supply > 0) {
          tokenSupply = supply;
          supplyFor = key;
        }
        return Number.isFinite(value) ? value : null;
      })
      .catch(() => null);
    poolPromise.then((value) => {
      if (currentPairKey() !== key || value == null) return;
      const at = Date.now();
      if (pooledFor === key && pooledEth === value && localPoolAt >= at) return;
      pooledEth = value;
      pooledFor = key;
      localPoolAt = at;
      renderPanel(lastUnlabeled, lastComplete);
      window.postMessage(
        {
          source: "twl-page",
          type: "quote",
          key,
          pair: info.pair.toLowerCase(),
          chain: info.chain,
          pooledEth: value,
          pooledAt: at
        },
        "*"
      );
    });
    readGas(info.chain).then((gwei) => {
      if (currentPairKey() !== key || gwei == null) return;
      const at = Date.now();
      gasGwei = gwei;
      gasFor = key;
      localGasAt = at;
      renderPanel(lastUnlabeled, lastComplete);
      window.postMessage(
        {
          source: "twl-page",
          type: "quote",
          key,
          pair: info.pair.toLowerCase(),
          chain: info.chain,
          gasGwei: gwei,
          gasAt: at
        },
        "*"
      );
    });
  }

  function statsRank(complete, indexed) {
    return (complete ? 2 : 0) * 1000000000 + (indexed || 0);
  }

  function preferredUnlabeled(unlabeled, complete) {
    const key = currentPairKey();
    if (!remoteStats || remoteStats.key !== key || !remoteStats.unlabeled) return { unlabeled, complete };
    const remoteRank = statsRank(remoteStats.complete, remoteStats.indexed);
    const localRank = statsRank(complete, txToMaker.size);
    if (remoteRank > localRank || (remoteRank === localRank && remoteStats.statsAt > localStatsAt)) {
      return { unlabeled: remoteStats.unlabeled, complete: Boolean(remoteStats.complete) };
    }
    return { unlabeled, complete };
  }

  function applyQuote(data) {
    const key = currentPairKey();
    if (!data || data.key !== key) return;
    let changed = false;
    if (typeof data.pooledEth === "number" && data.pooledAt >= localPoolAt && (pooledFor !== key || pooledEth !== data.pooledEth)) {
      pooledEth = data.pooledEth;
      pooledFor = key;
      localPoolAt = data.pooledAt;
      changed = true;
    }
    if (typeof data.gasGwei === "number" && data.gasAt >= localGasAt && (gasFor !== key || gasGwei !== data.gasGwei)) {
      gasGwei = data.gasGwei;
      gasFor = key;
      localGasAt = data.gasAt;
      changed = true;
    }
    if (changed) renderPanel(lastUnlabeled, lastComplete);
  }

  function applyRemoteStats(data) {
    if (!data || typeof data.pair !== "string") return;
    const key = (data.chain || "") + ":" + data.pair.toLowerCase();
    if (key !== currentPairKey()) return;
    remoteStats = {
      key,
      unlabeled: data.unlabeled,
      complete: Boolean(data.complete),
      indexed: Number(data.indexed) || 0,
      statsAt: Number(data.statsAt) || 0
    };
    renderPanel(lastUnlabeled, lastComplete);
  }

  function unlabeledTotals() {
    const labeled = {};
    for (const name of labelOrder) labeled[name] = { eth: 0, buyEth: 0, sellEth: 0, buys: 0, sells: 0 };
    let totalEth = 0;
    let totalBuyEth = 0;
    let totalSellEth = 0;
    let totalBuys = 0;
    let totalSells = 0;
    for (const trade of trades.values()) {
      const isSell = trade.type === "sell";
      totalEth += isSell ? -trade.amount : trade.amount;
      if (isSell) {
        totalSells += 1;
        totalSellEth += trade.amount;
      } else {
        totalBuys += 1;
        totalBuyEth += trade.amount;
      }
      const name = addressToLabel.get(trade.maker);
      if (!name || !Object.prototype.hasOwnProperty.call(labeled, name)) continue;
      labeled[name].eth += isSell ? -trade.amount : trade.amount;
      if (isSell) {
        labeled[name].sells += 1;
        labeled[name].sellEth += trade.amount;
      } else {
        labeled[name].buys += 1;
        labeled[name].buyEth += trade.amount;
      }
    }
    const unlabeled = {};
    for (const name of labelOrder) {
      const buys = totalBuys - labeled[name].buys;
      const sells = totalSells - labeled[name].sells;
      unlabeled[name] = {
        eth: roundEth(totalEth - labeled[name].eth),
        buyEth: roundEth(totalBuyEth - labeled[name].buyEth),
        sellEth: roundEth(totalSellEth - labeled[name].sellEth),
        buys,
        sells,
        count: buys + sells
      };
    }
    return unlabeled;
  }

  function formatAmount(value) {
    if (!Number.isFinite(value) || value === 0) return "0";
    const abs = Math.abs(value);
    const digits = abs < 0.000001 ? 10 : abs >= 1 ? 4 : 6;
    return abs.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }

  function formatTiny(value) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    if (abs === 0) return "0";
    if (abs >= 0.0001) return formatAmount(abs);
    const text = abs.toFixed(18);
    const zeros = (text.match(/^0\.(0*)/) || [, ""])[1].length;
    const digits = text.slice(2 + zeros, 2 + zeros + 4).replace(/0+$/, "");
    const sub = "₀₁₂₃₄₅₆₇₈₉";
    const mark = String(zeros)
      .split("")
      .map((digit) => sub[digit] || digit)
      .join("");
    return "0.0" + mark + digits;
  }

  function formatUsd(value) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    if (abs >= 1000) {
      const scaled = abs >= 1e9 ? abs / 1e9 : abs >= 1e6 ? abs / 1e6 : abs / 1e3;
      const suffix = abs >= 1e9 ? "B" : abs >= 1e6 ? "M" : "K";
      return "$" + scaled.toFixed(2) + suffix;
    }
    if (abs < 0.0001) return "$" + formatTiny(abs);
    return "$" + formatAmount(abs);
  }

  function formatTokenAmount(value) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 6;
    const parts = abs.toFixed(digits).split(".");
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const fraction = (parts[1] || "").replace(/0+$/, "");
    return fraction ? whole + "." + fraction : whole;
  }

  function formatTradeDate(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = (value) => String(value).padStart(2, "0");
    return (
      months[date.getMonth()] +
      " " +
      date.getDate() +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes()) +
      ":" +
      pad(date.getSeconds())
    );
  }

  function shortAddress(address) {
    return address.slice(0, 5) + "..." + address.slice(-4);
  }

  function readTradeHeaders() {
    const heads = [];
    const nodes = document.querySelectorAll(".p-datatable-thead th");
    for (const node of nodes) {
      const text = node.innerText.replace(/\s+/g, " ").trim();
      if (text) heads.push(text);
    }
    if (heads.length >= 4) tradeHeaders = heads;
    return tradeHeaders;
  }

  function tradeCell(header, trade) {
    const name = header.toLowerCase();
    if (name === "date") return formatTradeDate(trade.timestamp);
    if (name === "type") return trade.type === "sell" ? "SELL" : "BUY";
    if (name === "mcap" || name === "market cap") {
      return supplyFor === currentPairKey() && tokenSupply && trade.price != null ? formatUsd(trade.price * tokenSupply) : "";
    }
    if (name === "price usd") return trade.price != null ? formatUsd(trade.price) : "";
    if (name === "price eth") return trade.priceETH != null ? formatTiny(trade.priceETH) : "";
    if (name === "total usd") return trade.amountUSD != null ? formatUsd(trade.amountUSD) : "";
    if (name === "total eth") return trade.amount != null ? formatAmount(trade.amount) : "";
    if (name === "maker") return shortAddress(trade.maker);
    return trade.amountToken != null ? formatTokenAmount(trade.amountToken) : "";
  }

  function unlabeledTrades() {
    const rows = [];
    for (const trade of trades.values()) {
      if (trade.type !== "buy" && trade.type !== "sell") continue;
      if (addressToLabel.has(trade.maker)) continue;
      rows.push(trade);
    }
    rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || String(b.id).localeCompare(String(a.id)));
    return rows;
  }

  function txLink(id) {
    const info = pairFromLocation();
    const chain = info ? info.chain : "ether";
    const bases = {
      ether: "https://etherscan.io/tx/",
      bsc: "https://bscscan.com/tx/",
      polygon: "https://polygonscan.com/tx/",
      base: "https://basescan.org/tx/",
      arbitrum: "https://arbiscan.io/tx/",
      avalanche: "https://snowtrace.io/tx/",
      optimism: "https://optimistic.etherscan.io/tx/"
    };
    return (bases[chain] || bases.ether) + id;
  }

  function renderTrades(complete) {
    const root = document.documentElement;
    let table = document.getElementById("twl-trades");
    if (!showSum || !showTable || !labelOrder.length) {
      if (table) table.remove();
      return;
    }
    const headers = readTradeHeaders();
    const rows = unlabeledTrades();
    if (!table) {
      table = document.createElement("section");
      table.id = "twl-trades";
      table.className = "twl-trades";
      root.appendChild(table);
    }
    const previousScroll = table.querySelector(".twl-trades-scroll");
    const scrollTop = previousScroll ? previousScroll.scrollTop : 0;
    table.textContent = "";
    const head = document.createElement("div");
    head.className = "twl-trades-head";
    const title = document.createElement("div");
    title.className = "twl-trades-title";
    title.textContent = "Unlabeled trades";
    const tools = document.createElement("div");
    tools.className = "twl-trades-tools";
    const hideTrades = document.createElement("button");
    hideTrades.type = "button";
    hideTrades.className = "twl-trades-hide";
    hideTrades.textContent = "Hide trades";
    hideTrades.addEventListener("click", () => {
      showTable = false;
      window.postMessage({ source: "twl-page", type: "show-table", showTable: false }, "*");
      renderPanel(lastUnlabeled, lastComplete);
    });
    const count = document.createElement("div");
    count.className = "twl-trades-count";
    count.textContent = rows.length + (rows.length === 1 ? " trade" : " trades") + (complete ? "" : " · counting");
    tools.append(hideTrades, count);
    head.append(title, tools);
    table.appendChild(head);
    const scroller = document.createElement("div");
    scroller.className = "twl-trades-scroll";
    const grid = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const header of headers) {
      const cell = document.createElement("th");
      cell.textContent = header;
      headRow.appendChild(cell);
    }
    thead.appendChild(headRow);
    const body = document.createElement("tbody");
    for (const trade of rows) {
      const row = document.createElement("tr");
      row.className = trade.type === "sell" ? "sell" : "buy";
      for (const header of headers) {
        const cell = document.createElement("td");
        if (header.toLowerCase() === "others" && trade.id) {
          const link = document.createElement("a");
          link.href = txLink(trade.id);
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = "Tx";
          cell.appendChild(link);
        } else if (header.toLowerCase() === "type") {
          cell.textContent = tradeCell(header, trade);
          cell.className = "type";
        } else {
          cell.textContent = tradeCell(header, trade);
        }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    grid.append(thead, body);
    scroller.appendChild(grid);
    table.appendChild(scroller);
    scroller.scrollTop = scrollTop;
  }

  function poolStat(label, value) {
    const stat = document.createElement("span");
    stat.className = "twl-sum-stat";
    const name = document.createElement("span");
    name.className = "twl-sum-stat-label";
    name.textContent = label;
    const amount = document.createElement("span");
    amount.className = "twl-sum-pool-value";
    amount.textContent = value;
    stat.append(name, amount);
    return stat;
  }

  function renderPanel(unlabeled, complete) {
    lastUnlabeled = unlabeled;
    lastComplete = complete;
    const shown = preferredUnlabeled(unlabeled, complete);
    unlabeled = shown.unlabeled;
    complete = shown.complete;
    const root = document.documentElement;
    if (!root) return;
    let panel = document.getElementById("twl-unlabeled");
    const names = labelOrder.filter((name) => unlabeled[name]);
    if (!showSum || !names.length) {
      if (panel) panel.remove();
      renderTrades(complete);
      return;
    }
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "twl-unlabeled";
      panel.className = "twl-sum";
      root.appendChild(panel);
    }
    panel.textContent = "";
    const head = document.createElement("div");
    head.className = "twl-sum-head";
    const title = document.createElement("div");
    title.className = "twl-sum-title";
    title.textContent = "Unlabeled Total ETH";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "twl-sum-hide";
    toggle.textContent = showTable ? "Hide trades" : "Show trades";
    toggle.title = "Show or hide the unlabeled trades table.";
    toggle.addEventListener("click", () => {
      showTable = !showTable;
      window.postMessage({ source: "twl-page", type: "show-table", showTable }, "*");
      renderPanel(lastUnlabeled, lastComplete);
    });
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "twl-sum-hide";
    hide.textContent = "Hide";
    hide.title = "Hide this card. Turn it back on from the extension popup.";
    hide.addEventListener("click", () => {
      showSum = false;
      const current = document.getElementById("twl-unlabeled");
      if (current) current.remove();
      const tradesPanel = document.getElementById("twl-trades");
      if (tradesPanel) tradesPanel.remove();
      window.postMessage({ source: "twl-page", type: "hide-sum" }, "*");
    });
    const actions = document.createElement("div");
    actions.className = "twl-sum-actions";
    actions.append(toggle, hide);
    head.append(title, actions);
    panel.appendChild(head);
    for (const name of names) {
      const item = unlabeled[name];
      const row = document.createElement("div");
      row.className = "twl-sum-row";
      const label = document.createElement("span");
      label.className = "twl-sum-name";
      label.textContent = name;
      const value = document.createElement("span");
      const tone = item.eth < 0 ? " neg" : item.eth > 0 ? " pos" : "";
      value.className = "twl-sum-value" + tone;
      value.textContent = formatEth(item.eth) + " ETH";
      value.title =
        item.buys +
        " buys and " +
        item.sells +
        " sells not labeled " +
        name +
        ". Buys add Total ETH. Sells subtract Total ETH.";
      row.append(label, value);
      panel.appendChild(row);
      const totals = document.createElement("div");
      totals.className = "twl-sum-counts";
      const buyEth = typeof item.buyEth === "number" ? item.buyEth : 0;
      const sellEth = typeof item.sellEth === "number" ? item.sellEth : 0;
      totals.textContent = "Buy total " + formatAmount(buyEth) + " ETH · Sell total " + formatAmount(sellEth) + " ETH";
      panel.appendChild(totals);
      const counts = document.createElement("div");
      counts.className = "twl-sum-counts";
      counts.textContent = item.count + " trades · " + item.buys + " buys · " + item.sells + " sells";
      panel.appendChild(counts);
    }
    const note = document.createElement("div");
    note.className = "twl-sum-note";
    note.textContent = complete
      ? "Buys add, sells subtract. Full pair history."
      : "Buys add, sells subtract. Counting the full pair.";
    panel.appendChild(note);
    const pool = document.createElement("div");
    pool.className = "twl-sum-pool";
    const pooled = pooledFor === currentPairKey() ? pooledEth : null;
    const gas = gasFor === currentPairKey() ? gasGwei : null;
    pool.append(
      poolStat("Pooled ETH", pooled == null ? "…" : formatPool(pooled) + " ETH"),
      poolStat("Gas", gas == null ? "…" : formatGwei(gas))
    );
    panel.appendChild(pool);
    placePanel(panel);
    renderTrades(complete);
  }

  function placePanel(panel) {
    const margin = 10;
    const footer = document.querySelector(".fixed-footer");
    let lift = window.innerWidth > 1100 ? 64 : 16;
    if (footer) {
      const rect = footer.getBoundingClientRect();
      if (rect.height > 24 && rect.bottom >= window.innerHeight - 8 && rect.top < window.innerHeight) {
        lift = Math.round(window.innerHeight - rect.top) + 10;
      }
    }
    const width = Math.min(340, Math.max(220, window.innerWidth - margin * 2));
    panel.style.boxSizing = "border-box";
    panel.style.right = margin + "px";
    panel.style.left = "auto";
    panel.style.bottom = lift + "px";
    panel.style.width = width + "px";
    panel.style.maxHeight = Math.max(120, window.innerHeight - lift - margin) + "px";
    panel.style.overflow = "auto";
  }

  function publishStats(info) {
    const byName = {};
    let matched = 0;
    for (const maker of txToMaker.values()) {
      const name = addressToLabel.get(maker);
      if (!name) continue;
      matched += 1;
      byName[name] = (byName[name] || 0) + 1;
    }
    const unlabeled = unlabeledTotals();
    localStatsAt = Date.now();
    renderPanel(unlabeled, indexComplete);
    window.postMessage(
      {
        source: "twl-page",
        type: "stats",
        pair: info.pair.toLowerCase(),
        chain: info.chain,
        page: location.pathname,
        matched,
        indexed: txToMaker.size,
        complete: indexComplete,
        statsAt: localStatsAt,
        byName,
        unlabeled
      },
      "*"
    );
  }

  function startIndex() {
    const info = pairFromLocation();
    if (!info) return;
    const key = info.chain + ":" + info.pair.toLowerCase();
    if (indexedKey === key) return;
    txToMaker.clear();
    trades.clear();
    indexedKey = key;
    indexComplete = false;
    notifyReady = false;
    if (pooledFor !== key) {
      pooledEth = null;
      pooledFor = "";
      gasGwei = null;
      gasFor = "";
    }
    renderPanel(unlabeledTotals(), false);
    refreshPooled();
    const token = ++indexToken;
    const headers = { "X-API-Version": "2", Accept: "application/json" };
    const base =
      "https://www.dextools.io/api/core/pool/events/" +
      encodeURIComponent(info.chain) +
      "/" +
      info.pair;
    let cursor = null;
    const seen = new Set();
    let pages = 0;

    const step = () => {
      if (token !== indexToken) return;
      if (pages >= 250) {
        markIndexComplete();
        publishStats(info);
        schedule();
        return;
      }
      const url = cursor
        ? base +
          "/desc?blockNumber=" +
          cursor.blockNumber +
          "&date=" +
          encodeURIComponent(cursor.date || "") +
          "&logIndex=" +
          cursor.logIndex +
          "&limit=100"
        : base + "/newest?limit=100";
      const fetchImpl = nativeFetch || window.fetch;
      fetchImpl(url, { headers })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.text();
        })
        .then((text) => {
          if (token !== indexToken) return;
          ingestText(text);
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (error) {
            data = null;
          }
          const events = data && data.data && data.data.events;
          const next = data && data.data && data.data.next;
          pages += 1;
          if (!events || !events.length || !next || next.blockNumber == null || next.logIndex == null) {
            markIndexComplete();
            publishStats(info);
            schedule();
            return;
          }
          const mark = next.blockNumber + ":" + next.logIndex + ":" + next.date;
          if (seen.has(mark)) {
            markIndexComplete();
            publishStats(info);
            schedule();
            return;
          }
          seen.add(mark);
          cursor = next;
          step();
        })
        .catch(() => {
          if (token !== indexToken) return;
          if (!cursor) indexedKey = "";
          publishStats(info);
          schedule();
        });
    };
    step();
  }

  function hookHistory() {
    const wrap = (fn) =>
      function () {
        const result = fn.apply(this, arguments);
        startIndex();
        schedule();
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", () => {
      startIndex();
      schedule();
    });
  }

  function setLabels(labels) {
    const next = new Map();
    const list = Array.isArray(labels) ? labels.slice() : [];
    list.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const label of list) {
      const name = String(label.name ?? "");
      if (name === "") continue;
      const addresses = Array.isArray(label.addresses) ? label.addresses : [];
      for (const address of addresses) {
        if (isAddr(address)) next.set(address.toLowerCase(), name);
      }
    }
    const tails = new Map();
    for (const address of next.keys()) {
      const tail = address.slice(-4);
      let bucket = tails.get(tail);
      if (!bucket) {
        bucket = [];
        tails.set(tail, bucket);
      }
      bucket.push(address);
    }
    addressToLabel = next;
    tailIndex = tails;
    const ordered = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const seenNames = new Set();
    labelOrder = [];
    for (const label of ordered) {
      const name = String(label.name ?? "");
      if (name === "" || seenNames.has(name)) continue;
      let owns = false;
      for (const value of next.values()) {
        if (value === name) {
          owns = true;
          break;
        }
      }
      if (!owns) continue;
      seenNames.add(name);
      labelOrder.push(name);
    }
    schedule();
    queueStats();
    labelsReady = true;
    armNotifications();
  }

  function markIndexComplete() {
    indexComplete = true;
    armNotifications();
  }

  function filteredMaker() {
    const match = location.search.match(/[?&]maker=(0x[a-fA-F0-9]{40})/i);
    if (!match) return null;
    const maker = match[1].toLowerCase();
    const label = addressToLabel.get(maker);
    return label ? { label, maker, title: maker } : null;
  }

  function visibleAddressText(span) {
    let text = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.classList.contains("twl-badge")) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(span);
    return text;
  }

  function truncationHits(span) {
    const text = visibleAddressText(span);
    const full = text.match(/0x[a-fA-F0-9]{40}/);
    if (full) {
      const maker = full[0].toLowerCase();
      return addressToLabel.has(maker) ? [maker] : [];
    }
    const short = text.match(/0x([a-fA-F0-9]{2,8})(?:\.{3}|…)([a-fA-F0-9]{2,8})/);
    if (!short || tailIndex.size === 0) return [];
    const prefix = short[1].toLowerCase();
    const suffix = short[2].toLowerCase();
    const bucket = tailIndex.get(suffix.slice(-4));
    if (!bucket) return [];
    const hits = [];
    for (const address of bucket) {
      if (address.startsWith("0x" + prefix) && address.endsWith(suffix)) hits.push(address);
    }
    return hits;
  }

  function resolveSpan(span, row) {
    const tx = txOf(row);
    const txMaker = tx ? txToMaker.get(tx) : null;
    const hits = truncationHits(span);
    if (hits.length === 1) {
      const maker = hits[0];
      return { label: addressToLabel.get(maker), maker, title: maker };
    }
    if (hits.length > 1) {
      if (txMaker && hits.indexOf(txMaker) !== -1) {
        const label = addressToLabel.get(txMaker);
        if (label) return { label, maker: txMaker, title: txMaker };
      }
      const names = new Set(hits.map((address) => addressToLabel.get(address)));
      if (names.size === 1) {
        const label = [...names][0];
        return { label, maker: hits[0], title: hits.join("\n") };
      }
      return null;
    }
    if (txMaker) {
      const label = addressToLabel.get(txMaker);
      if (label) return { label, maker: txMaker, title: txMaker };
    }
    const filtered = filteredMaker();
    if (!filtered) return null;
    const text = visibleAddressText(span);
    const short = text.match(/0x([a-fA-F0-9]{2,8})(?:\.{3}|…)([a-fA-F0-9]{2,8})/);
    if (!short) return filtered;
    const prefix = short[1].toLowerCase();
    const suffix = short[2].toLowerCase();
    if (filtered.maker.startsWith("0x" + prefix) && filtered.maker.endsWith(suffix)) return filtered;
    return null;
  }

  function txOf(row) {
    const links = row.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/tx\/(0x[a-fA-F0-9]{64})/i);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  function applySpan(span, label, maker, title) {
    let badge = span.querySelector(":scope > .twl-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "twl-badge";
      span.appendChild(badge);
    }
    const tip = title || maker;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.dataset.maker !== maker) badge.dataset.maker = maker;
    if (badge.title !== tip) badge.title = tip;
    span.classList.add("twl-labeled");
  }

  function restoreSpan(span) {
    if (!span.classList.contains("twl-labeled") && !span.querySelector(":scope > .twl-badge")) return;
    span.classList.remove("twl-labeled");
    const badge = span.querySelector(":scope > .twl-badge");
    if (badge) badge.remove();
  }

  function scan() {
    if (scanning || !document.body) return;
    scanning = true;
    try {
      const spans = document.querySelectorAll("span.only-address");
      for (const span of spans) {
        if (span.closest("[data-tippy-root], .tippy-box, .tippy-content")) continue;
        const row = span.closest("tr");
        if (!row) continue;
        const resolved = resolveSpan(span, row);
        if (resolved) applySpan(span, resolved.label, resolved.maker, resolved.title);
        else restoreSpan(span);
      }
    } finally {
      scanning = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "twl") return;
    if (data.type === "labels") setLabels(data.labels);
    if (data.type === "quote") applyQuote(data);
    if (data.type === "stats-sync") applyRemoteStats(data);
    if (data.type === "settings") {
      showSum = Boolean(data.showSum);
      if (typeof data.showTable === "boolean") showTable = data.showTable;
      renderPanel(lastUnlabeled, lastComplete);
      if (showSum) refreshPooled();
    }
  });

  hookFetch();
  hookXhr();
  hookWebSocket();
  hookHistory();

  const start = () => {
    const root = document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(() => schedule());
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    const requestLabels = () => window.postMessage({ source: "twl-page", type: "request-labels" }, "*");
    startIndex();
    setTimeout(startIndex, 1500);
    schedule();
    setInterval(() => {
      startIndex();
      schedule();
      const panel = document.getElementById("twl-unlabeled");
      if (panel) placePanel(panel);
    }, 700);
    requestLabels();
    setTimeout(requestLabels, 400);
    setTimeout(requestLabels, 1500);
    refreshPooled();
    setInterval(refreshPooled, 10000);
  };

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
