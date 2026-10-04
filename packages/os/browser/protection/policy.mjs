/** Shared Chromium DNR mechanism. Never truncate a feed to fit a quota. */
export const RULE_BASE = 10000,
  MAX_DOMAINS = 1200000,
  CHUNK = 2000;
export function compileThreatRules(
  domains,
  extensionId,
  { warningPage = "warning.html" } = {},
) {
  if (!/^[a-z][a-z0-9-]*\.html$/.test(warningPage))
    throw Error("Invalid warning page");
  if (!/^[a-p]{32}$/.test(extensionId))
    throw Error("Invalid extension identity");
  const unique = [...new Set(domains)].sort();
  if (!unique.length || unique.length > MAX_DOMAINS)
    throw Error("Invalid threat list size");
  for (const host of unique)
    if (
      host.length > 253 ||
      !host.includes(".") ||
      !host
        .split(".")
        .every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
    )
      throw Error("Invalid threat domain");
  const rules = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const requestDomains = unique.slice(i, i + CHUNK),
      offset = 2 * (i / CHUNK);
    rules.push({
      id: RULE_BASE + offset,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains, excludedResourceTypes: ["main_frame"] },
    });
    rules.push({
      id: RULE_BASE + offset + 1,
      priority: 2,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: `chrome-extension://${extensionId}/${warningPage}#\\1`,
        },
      },
      condition: {
        requestDomains,
        resourceTypes: ["main_frame"],
        regexFilter: "^(https?://.*)$",
      },
    });
  }
  return rules;
}
export function exceptionRule(address, tabId) {
  const url = new URL(address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 800 ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0
  )
    throw Error("Cannot open this address with a temporary exception");
  url.hash = "";
  return {
    id: 1,
    priority: 100,
    action: { type: "allow" },
    condition: {
      tabIds: [tabId],
      resourceTypes: ["main_frame"],
      requestMethods: ["get"],
      regexFilter: `^${url.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      isUrlFilterCaseSensitive: true,
    },
  };
}
export async function installThreatRules(api, domains, extensionId, options) {
  const addRules = compileThreatRules(domains, extensionId, options);
  const current = await api.getDynamicRules();
  // This module owns only its reserved interval. Preserve other component rules.
  const removeRuleIds = current
    .filter((r) => r.id >= RULE_BASE && r.id < RULE_BASE + 2000)
    .map((r) => r.id);
  await api.updateDynamicRules({ removeRuleIds, addRules });
  return addRules.length;
}
