import {
  downloadThreatFeed,
  exceptionRule,
  installThreatRules,
  parseThreatDomains,
  REPUTATION_FEEDS,
  validFeedTime,
} from "./policy.mjs";

const SOURCES = REPUTATION_FEEDS;
const HOUR = 3600000;
const validTime = (t) => validFeedTime(t);
async function source(feed) {
  const { body, publishedAt } = await downloadThreatFeed(feed);
  return { domains: [...parseThreatDomains(body)], publishedAt };
}
let refreshing;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let protection;
    try {
      ({ protection } = await chrome.storage.local.get("protection"));
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      if (
        validTime(protection?.updatedAt) &&
        protection.updatedAt > Date.now() - 6 * HOUR &&
        validTime(protection.publishedAt) &&
        rules.filter((r) => r.id >= 10000 && r.id < 12000).length ===
          protection.ruleCount &&
        protection.ruleCount > 0
      )
        return;
      const sources = await Promise.all(SOURCES.map(source));
      const ruleCount = await installThreatRules(
        chrome.declarativeNetRequest,
        sources.flatMap((s) => s.domains),
        chrome.runtime.id,
      );
      await chrome.storage.local.set({
        protection: {
          updatedAt: Date.now(),
          publishedAt: Math.min(...sources.map((s) => s.publishedAt)),
          ruleCount,
          status: "current",
        },
      });
    } catch {
      // Keep last-known deny rules during outages. Never describe stale rules as current.
      await chrome.storage.local
        .set({ protection: { ...protection, status: "unavailable" } })
        .catch(() => {});
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
chrome.runtime.onInstalled.addListener(() => void refresh());
chrome.runtime.onStartup.addListener(() => void refresh());
chrome.alarms.create("eliza-protection-refresh", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "eliza-protection-refresh") void refresh();
  // Expire exceptions created before consumers adopted the shared worker.
  if (
    ["eliza-protection-exception", "senior-protection-exception"].includes(
      alarm.name,
    )
  )
    void chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
    });
});
// Only a top-level extension warning page can request an exception. A website,
// content script or embedded warning frame cannot grant itself permission.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !sender.url?.startsWith(chrome.runtime.getURL("warning.html") + "#") ||
    !Number.isInteger(sender.tab?.id)
  )
    return;
  if (message?.type !== "open-temporarily") return;
  const address = sender.url.slice(sender.url.indexOf("#") + 1);
  (async () => {
    const rule = exceptionRule(address, sender.tab.id);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [rule],
    });
    await chrome.alarms.create("eliza-protection-exception", {
      when: Date.now() + 60000,
    });
    await chrome.tabs.update(sender.tab.id, { url: address });
    respond({ ok: true });
  })().catch(async () => {
    // A failed tab navigation must not leave a permission behind.
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [1] })
      .catch(() => {});
    respond({ ok: false });
  });
  return true;
});
// Expire the exception as soon as the permitted document commits or its tab closes.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0)
    void chrome.declarativeNetRequest.getSessionRules().then((rules) => {
      if (
        rules.some(
          (r) => r.id === 1 && r.condition.tabIds?.includes(details.tabId),
        )
      )
        return chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [1],
        });
    });
});
chrome.tabs.onRemoved.addListener(
  (tabId) =>
    void chrome.declarativeNetRequest.getSessionRules().then((rules) => {
      if (rules.some((r) => r.id === 1 && r.condition.tabIds?.includes(tabId)))
        return chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [1],
        });
    }),
);
void refresh();
