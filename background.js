const recent = new Map();

function noteId(message) {
  return "twl-" + message.tradeType + "-" + String(message.id).slice(2, 18);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "unlabeled-trade" || typeof message.id !== "string") return;
  const now = Date.now();
  const previous = recent.get(message.id + ":" + message.tradeType);
  if (previous && now - previous < 60000) return;
  recent.set(message.id + ":" + message.tradeType, now);
  if (recent.size > 200) {
    for (const [key, at] of recent) {
      if (now - at > 60000) recent.delete(key);
    }
  }
  const title = message.tradeType === "sell" ? "New sell detected!" : "New buy detected!";
  const time = message.time || "Just now";
  const amount = message.amount || "0";
  const maker = message.maker || "";
  chrome.notifications.create(noteId(message), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: "Time: " + time + "\nTotal ETH: " + amount + "\nMaker: " + maker,
    priority: 2
  });
});
