import { createProtectionAdvisory } from "./advisory.mjs";
import {
  downloadThreatFeed,
  exceptionRule,
  installThreatRules,
  parseThreatDomains,
  plausibleTime,
} from "./policy.mjs";
/** Install one shared protection engine inside a host-owned extension worker. */
export function installBrowserProtection({
  chrome: chromeApi,
  fetchImpl = globalThis.fetch,
  advisory,
  feeds,
  warningPage = "warning.html",
  refreshAlarm = "eliza-protection-refresh",
  exceptionAlarm = "eliza-protection-exception",
}) {
  if (!Array.isArray(feeds) || !feeds.length || feeds.length > 8)
    throw Error("Protection feeds are required");
  if (!/^[a-z][a-z0-9-]*\.html$/.test(warningPage))
    throw Error("Invalid warning page");
  const chrome = chromeApi,
    fetch = fetchImpl,
    SOURCES = feeds;
  const advice = advisory
    ? createProtectionAdvisory(chrome, { ...advisory, warningPage })
    : null;
  const HOUR = 3600000;
  async function source(feed) {
    const { body, publishedAt } = await downloadThreatFeed(
      { ...feed, mirror: feed.mirror ?? feed.id === "phishing" },
      { fetchImpl: fetch },
    );
    return { domains: [...parseThreatDomains(body)], publishedAt };
  }
  const installed = (rules, protection) =>
    protection?.ruleCount > 0 &&
    rules.filter((r) => r.id >= 10000 && r.id < 12000).length ===
      protection.ruleCount;
  let refreshing;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let protection;
      try {
        ({ protection } = await chrome.storage.local.get("protection"));
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        // Age only schedules a refresh; it never makes saved rules unusable.
        if (
          plausibleTime(protection?.updatedAt) &&
          protection.updatedAt > Date.now() - 6 * HOUR &&
          installed(rules, protection)
        )
          return;
        const sources = await Promise.all(SOURCES.map(source));
        const ruleCount = await installThreatRules(
          chrome.declarativeNetRequest,
          sources.flatMap((s) => s.domains),
          chrome.runtime.id,
          { warningPage },
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
        // Keep last-known deny rules during outages. Saved rules count at any
        // age ("current" means loaded); only missing rules are unavailable.
        const rules = await chrome.declarativeNetRequest
          .getDynamicRules()
          .catch(() => []);
        await chrome.storage.local
          .set({
            protection: {
              ...protection,
              status: installed(rules, protection) ? "current" : "unavailable",
            },
          })
          .catch(() => {});
      }
    })().finally(() => {
      void advice
        ?.refreshAll()
        .catch(() => console.warn("Protection advice refresh unavailable"));
      refreshing = null;
    });
    return refreshing;
  }
  chrome.runtime.onInstalled.addListener(() => void refresh());
  chrome.runtime.onStartup.addListener(() => void refresh());
  chrome.alarms.create(refreshAlarm, { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === refreshAlarm) void refresh();
    if (alarm.name === exceptionAlarm)
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
      !sender.url?.startsWith(`${chrome.runtime.getURL(warningPage)}#`) ||
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
      await chrome.alarms.create(exceptionAlarm, { when: Date.now() + 60000 });
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
        if (
          rules.some((r) => r.id === 1 && r.condition.tabIds?.includes(tabId))
        )
          return chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [1],
          });
      }),
  );
  void refresh();

  return { refresh, advisory: advice };
}
