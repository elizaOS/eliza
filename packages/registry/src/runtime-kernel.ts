/**
 * Canonical runtime kernel for decoding, normalizing, searching, and expiring
 * plugin marketplace data. Host packages retain network, filesystem, security,
 * and persistence policy while adapting this transport-neutral representation.
 */
import { z } from "zod";

const nullableString = z.string().nullable().optional();
const versionTargetSchema = z
  .object({ branch: nullableString, version: nullableString })
  .passthrough();
const appSchema = z
  .object({
    displayName: z.string().optional(),
    category: z.string().optional(),
    launchType: z.string().optional(),
    launchUrl: nullableString,
    icon: nullableString,
    heroImage: nullableString,
    capabilities: z.array(z.string()).optional(),
    minPlayers: z.number().nullable().optional(),
    maxPlayers: z.number().nullable().optional(),
    runtimePlugin: z.string().optional(),
    bridgeExport: z.string().optional(),
    uiExtension: z.object({ detailPanelId: z.string() }).optional(),
    viewer: z
      .object({
        url: z.string(),
        embedParams: z.record(z.string(), z.string()).optional(),
        postMessageAuth: z.boolean().optional(),
        sandbox: z.string().optional(),
      })
      .optional(),
    session: z
      .object({
        mode: z.enum(["viewer", "spectate-and-steer", "external"]),
        features: z
          .array(
            z.enum(["commands", "telemetry", "pause", "resume", "suggestions"]),
          )
          .optional(),
      })
      .optional(),
    developerOnly: z.boolean().optional(),
    visibleInAppStore: z.boolean().optional(),
    mainTab: z.boolean().optional(),
    catalogSection: z.string().optional(),
    featured: z.boolean().optional(),
    defaultHidden: z.boolean().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export const runtimeRegistryEntrySchema = z
  .object({
    git: z.object({
      repo: z.string().min(1),
      v0: versionTargetSchema,
      v1: versionTargetSchema,
      v2: versionTargetSchema,
    }),
    npm: z
      .object({
        repo: z.string().min(1),
        v0: nullableString,
        v1: nullableString,
        v2: nullableString,
        v0CoreRange: nullableString,
        v1CoreRange: nullableString,
        v2CoreRange: nullableString,
      })
      .passthrough(),
    supports: z.object({ v0: z.boolean(), v1: z.boolean(), v2: z.boolean() }),
    description: z.string().optional(),
    homepage: nullableString,
    topics: z.array(z.string()).optional(),
    stargazers_count: z.number().optional(),
    language: z.string().optional(),
    origin: z.string().optional(),
    source: z.string().optional(),
    support: z.string().optional(),
    builtIn: z.boolean().optional(),
    firstParty: z.boolean().optional(),
    thirdParty: z.boolean().optional(),
    status: z.string().optional(),
    kind: z.string().optional(),
    registryKind: z.string().optional(),
    directory: nullableString,
    app: appSchema.optional(),
  })
  .passthrough();

const runtimeRegistryFileSchema = z.object({
  registry: z.record(z.string(), runtimeRegistryEntrySchema),
  apps: z.record(z.string(), runtimeRegistryEntrySchema).optional(),
  lastUpdatedAt: z.string().optional(),
});

export type RuntimeRegistryWireEntry = z.infer<
  typeof runtimeRegistryEntrySchema
>;

export interface NormalizedRegistryEntry {
  name: string;
  gitRepo: string;
  gitUrl: string;
  directory: string | null;
  description: string;
  homepage: string | null;
  topics: string[];
  stars: number;
  language: string;
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
    v0CoreRange: string | null;
    v1CoreRange: string | null;
    v2CoreRange: string | null;
  };
  git: {
    v0Branch: string | null;
    v1Branch: string | null;
    v2Branch: string | null;
  };
  supports: { v0: boolean; v1: boolean; v2: boolean };
  kind?: string;
  registryKind?: string;
  origin?: string;
  source?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
  app?: z.infer<typeof appSchema>;
}

export interface DecodeRuntimeRegistryOptions {
  sanitizeSandbox?: (value?: string) => string;
}

function normalizeEntry(
  name: string,
  entry: RuntimeRegistryWireEntry,
  options: DecodeRuntimeRegistryOptions,
): NormalizedRegistryEntry {
  const app = entry.app
    ? {
        ...entry.app,
        viewer: entry.app.viewer
          ? {
              ...entry.app.viewer,
              sandbox: options.sanitizeSandbox
                ? options.sanitizeSandbox(entry.app.viewer.sandbox)
                : entry.app.viewer.sandbox,
            }
          : undefined,
      }
    : undefined;
  return {
    name,
    gitRepo: entry.git.repo,
    gitUrl: `https://github.com/${entry.git.repo}.git`,
    directory: entry.directory ?? null,
    description: entry.description || "",
    homepage: entry.homepage ?? null,
    topics: entry.topics ?? [],
    stars: entry.stargazers_count ?? 0,
    language: entry.language || "TypeScript",
    npm: {
      package: entry.npm.repo,
      v0Version: entry.npm.v0 ?? null,
      v1Version: entry.npm.v1 ?? null,
      v2Version: entry.npm.v2 ?? null,
      v0CoreRange: entry.npm.v0CoreRange ?? null,
      v1CoreRange: entry.npm.v1CoreRange ?? null,
      v2CoreRange: entry.npm.v2CoreRange ?? null,
    },
    git: {
      v0Branch: entry.git.v0.branch ?? null,
      v1Branch: entry.git.v1.branch ?? null,
      v2Branch: entry.git.v2.branch ?? null,
    },
    supports: entry.supports,
    kind: entry.kind ?? (entry.app ? "app" : undefined),
    registryKind: entry.registryKind,
    origin: entry.origin,
    source: entry.source,
    support: entry.support,
    builtIn: entry.builtIn,
    firstParty: entry.firstParty,
    thirdParty: entry.thirdParty,
    status: entry.status,
    app,
  };
}

/** Decode the generated wire document once and return one normalized map. */
export function decodeRuntimeRegistry(
  input: unknown,
  options: DecodeRuntimeRegistryOptions = {},
): Map<string, NormalizedRegistryEntry> {
  const decoded = runtimeRegistryFileSchema.parse(input);
  const result = new Map<string, NormalizedRegistryEntry>();
  for (const [name, entry] of Object.entries(decoded.registry)) {
    result.set(name, normalizeEntry(name, entry, options));
  }
  for (const [name, entry] of Object.entries(decoded.apps ?? {})) {
    result.set(name, normalizeEntry(name, { ...entry, kind: "app" }, options));
  }
  return result;
}

export interface RegistrySearchable {
  name: string;
  description: string;
  topics: string[];
  stars: number;
}

export interface RegistrySearchPolicy {
  popularityBonuses: readonly [number, number, number];
}

export const AGENT_REGISTRY_SEARCH_POLICY: RegistrySearchPolicy = {
  popularityBonuses: [3, 3, 4],
};

export const CORE_REGISTRY_SEARCH_POLICY: RegistrySearchPolicy = {
  popularityBonuses: [5, 5, 5],
};

/** Score and deterministically order registry entries using one host-neutral policy. */
export function searchRegistryEntries<T extends RegistrySearchable>(
  entries: Iterable<T>,
  query: string,
  limit: number,
  extraNames: (entry: T) => string[] = () => [],
  extraTerms: (entry: T) => string[] = () => [],
  policy: RegistrySearchPolicy = AGENT_REGISTRY_SEARCH_POLICY,
): Array<{ entry: T; score: number }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || limit <= 0) return [];
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length > 1);
  const results: Array<{ entry: T; score: number }> = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const description = entry.description.toLowerCase();
    const aliases = extraNames(entry).map((value) => value.toLowerCase());
    let score = 0;
    if (
      name === normalizedQuery ||
      name === `@elizaos/${normalizedQuery}` ||
      aliases.includes(normalizedQuery)
    )
      score += 100;
    else if (
      name.includes(normalizedQuery) ||
      aliases.some((alias) => alias.includes(normalizedQuery))
    )
      score += 50;
    if (description.includes(normalizedQuery)) score += 30;
    for (const topic of entry.topics)
      if (topic.toLowerCase().includes(normalizedQuery)) score += 25;
    for (const term of extraTerms(entry))
      if (term.toLowerCase().includes(normalizedQuery)) score += 25;
    for (const term of terms) {
      if (name.includes(term) || aliases.some((alias) => alias.includes(term)))
        score += 15;
      if (description.includes(term)) score += 10;
      for (const topic of entry.topics)
        if (topic.toLowerCase().includes(term)) score += 8;
    }
    if (score > 0) {
      if (entry.stars > 100) score += policy.popularityBonuses[0];
      if (entry.stars > 500) score += policy.popularityBonuses[1];
      if (entry.stars > 1000) score += policy.popularityBonuses[2];
      results.push({ entry, score });
    }
  }
  return results
    .sort((left, right) => {
      const leftStars = Number.isFinite(left.entry.stars)
        ? left.entry.stars
        : 0;
      const rightStars = Number.isFinite(right.entry.stars)
        ? right.entry.stars
        : 0;
      return (
        right.score - left.score ||
        rightStars - leftStars ||
        left.entry.name.localeCompare(right.entry.name)
      );
    })
    .slice(0, limit);
}

/** Shared TTL rule; hosts remain responsible for cache storage and invalidation. */
export function isRegistryCacheFresh(
  fetchedAt: number,
  ttlMs: number,
  now = Date.now(),
): boolean {
  return (
    Number.isFinite(fetchedAt) &&
    Number.isFinite(ttlMs) &&
    ttlMs >= 0 &&
    now >= fetchedAt &&
    now - fetchedAt < ttlMs
  );
}
