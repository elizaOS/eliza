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

// Shared feed decoding for the extension worker and a private application host.
// Only reviewed public feed endpoints are requested; visited URLs are never sent.
export const PHISHING_FEED =
  "https://phish.co.za/latest/phishing-domains-ACTIVE.txt";
export const THREAT_FEED =
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/tif.mini-onlydomains.txt";
export const REPUTATION_FEEDS = [
  {
    id: "phishing",
    mirror: true,
    url: PHISHING_FEED,
    source: "Phishing.Database",
    license: "MIT",
    licenseUrl:
      "https://github.com/Phishing-Database/Phishing.Database/blob/master/LICENSE",
    threats: ["SOCIAL_ENGINEERING"],
  },
  {
    id: "threats",
    url: THREAT_FEED,
    source: "HaGeZi TIF Mini",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/hagezi/dns-blocklists/blob/main/LICENSE",
    threats: ["MALWARE_OR_SCAM"],
  },
];
export const validFeedTime = (time, now = Date.now()) =>
  Number.isFinite(time) && time <= now + 300000 && now - time < 48 * 3600000;
export function parseThreatDomains(text, minimum = 1000) {
  const domains = new Set();
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    const host = line.trim().toLowerCase();
    if (!host || host.startsWith("#")) continue;
    if (
      host.length <= 253 &&
      host.includes(".") &&
      host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      domains.add(host);
    else invalid++;
  }
  if (domains.size < minimum || invalid > domains.size / 100)
    throw Error("Invalid threat feed");
  return domains;
}
export async function readFeedBody(response, maximum = 24 * 1024 * 1024) {
  if (!response.ok) throw Error("Feed unavailable");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw Error("Feed too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
export async function downloadThreatFeed(
  feed,
  {
    fetchImpl = fetch,
    now = Date.now,
    minEntries = 1000,
    userAgent = undefined,
  } = {},
) {
  let body, publishedAt;
  try {
    const response = await fetchImpl(feed.url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    body = await readFeedBody(response);
    publishedAt = Date.parse(
      feed.id === "threats"
        ? body.match(/^# Last modified: (.+)$/m)?.[1]
        : response.headers.get("last-modified"),
    );
    if (!validFeedTime(publishedAt, now())) throw Error("Expired feed");
    parseThreatDomains(body, minEntries);
  } catch (error) {
    if (!feed.mirror) throw error;
    const response = await fetchImpl(
      "https://api.github.com/repos/Phishing-Database/Phishing.Database/commits?path=phishing-domains-ACTIVE.txt&per_page=1",
      {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        ...(userAgent
          ? {
              headers: {
                "User-Agent": userAgent,
                Accept: "application/vnd.github+json",
              },
            }
          : {}),
      },
    );
    const commits = JSON.parse(await readFeedBody(response, 128 * 1024));
    const sha = commits?.[0]?.sha;
    publishedAt = Date.parse(commits?.[0]?.commit?.committer?.date);
    if (!/^[a-f0-9]{40}$/.test(sha) || !validFeedTime(publishedAt, now()))
      throw Error("Invalid feed provenance");
    body = await readFeedBody(
      await fetchImpl(
        `https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/${sha}/phishing-domains-ACTIVE.txt`,
        { signal: AbortSignal.timeout(15000), redirect: "error" },
      ),
    );
  }
  return { body, publishedAt, downloadedAt: now() };
}
