import {
  hasAppInterface,
  packageNameToAppDisplayName,
  packageNameToAppRouteSlug,
} from "@elizaos/shared";
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

  const requestedBare = name.replace(/^@[^/]+\//, "").toLowerCase();

  if (!name.startsWith("@")) {
    p = registry.get(`@elizaos/${name}`);
    if (p) return p;

    p = registry.get(`@elizaos/plugin-${name}`);
    if (p) return p;

    p = registry.get(`@elizaos/app-${name}`);
    if (p) return p;
  }

  for (const [key, value] of registry) {
    if (key.toLowerCase().endsWith(`/${requestedBare}`)) return value;

    const aliases = new Set<string>();
    for (const candidate of [value.name, value.npm.package]) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      aliases.add(trimmed.replace(/^@[^/]+\//, "").toLowerCase());

      if (hasAppInterface(value)) {
        const routeSlug = packageNameToAppRouteSlug(trimmed);
        if (routeSlug) aliases.add(routeSlug.toLowerCase());
      }
    }

    if (aliases.has(requestedBare)) {
      return value;
    }
  }

  return null;
}

export function scoreEntries<T extends RegistryPluginInfo>(
  entries: Iterable<T>,
  query: string,
  limit: number,
  extraNames?: (p: T) => string[],
  extraTerms?: (p: T) => string[],
): Array<{ p: T; s: number }> {
  const lq = query.toLowerCase();
  const terms = lq.split(/\s+/).filter((t) => t.length > 1);
  const scored: Array<{ p: T; s: number }> = [];

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

export function toSearchResults<T extends RegistryPluginInfo>(
  results: Array<{ p: T; s: number }>,
): RegistrySearchResult[] {
  const max = results[0]?.s || 1;
  return results.map(({ p, s }) => ({
    name: p.name,
    description: p.description,
    score: s / max,
    tags: p.topics,
    version: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    latestVersion: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    npmPackage: p.npm.package,
    stars: p.stars,
    supports: p.supports,
    repository: `https://github.com/${p.gitRepo}`,
  }));
}

/**
 * Resolve a declared `heroImage` value to a URL the client can load.
 *
 * Accepts three shapes:
 *   - null / empty → `/api/apps/hero/<slug>` for generated fallback art
 *   - absolute URL / data URL / already-rooted `/api/...` or `/...` path → returned as-is
 *   - package-relative path (e.g. `"assets/hero.png"`) → rewritten to
 *     `/api/apps/hero/<slug>` so the runtime can stream it from the app's
 *     local package directory or synthesize fallback art
 */
export function resolveAppHeroImage(
  packageName: string,
  heroImage: string | null | undefined,
): string | null {
  const value = heroImage?.trim();
  if (
    value &&
    /^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/)/i.test(
      value,
    )
  ) {
    return value;
  }
  const slug = packageNameToAppRouteSlug(packageName);
  if (!slug) return null;
  return `/api/apps/hero/${slug}`;
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
    displayName: meta?.displayName ?? packageNameToAppDisplayName(p.name),
    description: p.description,
    category: meta?.category ?? "game",
    launchType: meta?.launchType ?? "url",
    launchUrl: meta?.launchUrl ?? p.homepage,
    icon: meta?.icon ?? null,
    heroImage: resolveAppHeroImage(p.name, meta?.heroImage),
    capabilities: meta?.capabilities ?? [],
    stars: p.stars,
    repository: `https://github.com/${p.gitRepo}`,
    latestVersion: p.npm.v2Version || p.npm.v1Version || p.npm.v0Version,
    supports: p.supports,
    npm: p.npm,
    uiExtension: meta?.uiExtension,
    viewer,
    session: meta?.session,
    developerOnly: meta?.developerOnly,
    visibleInAppStore: meta?.visibleInAppStore,
    mainTab: meta?.mainTab,
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
