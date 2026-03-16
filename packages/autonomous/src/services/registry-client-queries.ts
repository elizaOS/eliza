import type {
  RegistryAppInfo,
  RegistryPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult,
} from "./registry-client-types.js";

export function normalizePluginLookupAlias(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === "obsidan") return "obsidian";
  if (lower === "plugin-obsidan") return "plugin-obsidian";
  if (lower === "@elizaos/plugin-obsidan") return "@elizaos/plugin-obsidian";

  return trimmed;
}

export function getPluginInfoFromRegistry(
  registry: Map<string, RegistryPluginInfo>,
  name: string,
): RegistryPluginInfo | null {
  let p = registry.get(name);
  if (p) return p;

  if (!name.startsWith("@")) {
    p = registry.get(`@elizaos/${name}`);
    if (p) return p;

    p = registry.get(`@elizaos/plugin-${name}`);
    if (p) return p;
  }

  const bare = name.replace(/^@[^/]+\//, "");
  for (const [key, value] of registry) {
    if (key.endsWith(`/${bare}`)) return value;
  }

  return null;
}

export function scoreEntries(
  entries: Iterable<RegistryPluginInfo>,
  query: string,
  limit: number,
  extraNames?: (p: RegistryPluginInfo) => string[],
  extraTerms?: (p: RegistryPluginInfo) => string[],
): Array<{ p: RegistryPluginInfo; s: number }> {
  const lq = query.toLowerCase();
  const terms = lq.split(/\s+/).filter((t) => t.length > 1);
  const scored: Array<{ p: RegistryPluginInfo; s: number }> = [];

  for (const p of entries) {
    const ln = p.name.toLowerCase();
    const ld = p.description.toLowerCase();
    const aliases = extraNames?.(p) ?? [];
    let s = 0;

    if (ln === lq || ln === `@elizaos/${lq}` || aliases.some((a) => a === lq))
      s += 100;
    else if (ln.includes(lq) || aliases.some((a) => a.includes(lq))) s += 50;
    if (ld.includes(lq)) s += 30;
    for (const t of p.topics) if (t.toLowerCase().includes(lq)) s += 25;
    for (const t of extraTerms?.(p) ?? [])
      if (t.toLowerCase().includes(lq)) s += 25;
    for (const term of terms) {
      if (ln.includes(term) || aliases.some((a) => a.includes(term))) s += 15;
      if (ld.includes(term)) s += 10;
      for (const t of p.topics) if (t.toLowerCase().includes(term)) s += 8;
    }
    if (s > 0) {
      if (p.stars > 100) s += 3;
      if (p.stars > 500) s += 3;
      if (p.stars > 1000) s += 4;
      scored.push({ p, s });
    }
  }

  scored.sort((a, b) => b.s - a.s || b.p.stars - a.p.stars);
  return scored.slice(0, limit);
}

export function toSearchResults(
  results: Array<{ p: RegistryPluginInfo; s: number }>,
): RegistrySearchResult[] {
  const max = results[0]?.s || 1;
  return results.map(({ p, s }) => ({
    name: p.name,
    description: p.description,
    score: s / max,
    tags: p.topics,
    latestVersion: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    stars: p.stars,
    supports: p.supports,
    repository: `https://github.com/${p.gitRepo}`,
  }));
}

export function toAppInfo(
  p: RegistryPluginInfo,
  sanitizeSandbox: (value?: string) => string,
  defaultSandbox: string,
): RegistryAppInfo {
  const meta = p.appMeta;
  const viewer = meta?.viewer
    ? {
        url: meta.viewer.url,
        embedParams: meta.viewer.embedParams,
        postMessageAuth: meta.viewer.postMessageAuth,
        sandbox: sanitizeSandbox(meta.viewer.sandbox),
      }
    : meta?.launchType === "connect" || meta?.launchType === "local"
      ? {
          url: meta?.launchUrl ?? "",
          sandbox: defaultSandbox,
        }
      : undefined;

  return {
    name: p.name,
    displayName: meta?.displayName ?? p.name.replace(/^@elizaos\/app-/, ""),
    description: p.description,
    category: meta?.category ?? "game",
    launchType: meta?.launchType ?? "url",
    launchUrl: meta?.launchUrl ?? p.homepage,
    icon: meta?.icon ?? null,
    capabilities: meta?.capabilities ?? [],
    stars: p.stars,
    repository: `https://github.com/${p.gitRepo}`,
    latestVersion: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    supports: p.supports,
    npm: p.npm,
    uiExtension: meta?.uiExtension,
    viewer,
  };
}

export function toAppEntry(
  p: RegistryPluginInfo,
  resolveAppOverride: (
    packageName: string,
    appMeta: RegistryPluginInfo["appMeta"],
  ) => RegistryPluginInfo["appMeta"],
): RegistryPluginInfo | null {
  if (p.kind === "app" || p.appMeta) {
    return {
      ...p,
      kind: "app",
      appMeta: p.appMeta,
    };
  }

  const appMeta = resolveAppOverride(p.name, undefined);
  if (!appMeta) return null;
  return {
    ...p,
    kind: "app",
    appMeta,
  };
}

export function toPluginListItem(
  p: RegistryPluginInfo,
): RegistryPluginListItem {
  return {
    name: p.name,
    description: p.description,
    stars: p.stars,
    repository: `https://github.com/${p.gitRepo}`,
    topics: p.topics,
    latestVersion: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    supports: p.supports,
    npm: p.npm,
  };
}
