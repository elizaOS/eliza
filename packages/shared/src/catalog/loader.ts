/**
 * Registry loader. Validates raw entries and indexes them by id, kind, group,
 * and npm name, and provides the kind-narrowed accessors plus the legacy
 * `auth` → `accounts.agent` normalization.
 *
 * Static data only. Runtime overlay (enabled, configured, isActive) is merged
 * in at the API layer via `mergeWithRuntime()` — the loader never touches it.
 *
 * Validation is fail-loud at boot: bad entries throw with a precise zod
 * message naming the offending file, so a malformed entry can't slip into a
 * running process.
 */

import {
  type AccountAuthKind,
  type AppEntry,
  type ConnectorEntry,
  type PluginEntry,
  type RegistryEntry,
  type RegistryKind,
  type RegistryRuntimeOverlay,
  type RegistryView,
  registryEntrySchema,
} from "./schema.js";

export class RegistryValidationError extends Error {
  readonly file: string;
  readonly cause: unknown;
  constructor(file: string, cause: unknown) {
    super(`Registry entry at ${file} failed validation: ${String(cause)}`);
    this.name = "RegistryValidationError";
    this.file = file;
    this.cause = cause;
  }
}

export interface LoadedRegistry {
  byId: Map<string, RegistryEntry>;
  byKind: Map<RegistryKind, RegistryEntry[]>;
  byGroup: Map<string, RegistryEntry[]>;
  byNpmName: Map<string, RegistryEntry>;
  all: RegistryEntry[];
}

interface RawEntry {
  file: string;
  data: unknown;
}

export function loadRegistryFromRawEntries(raws: RawEntry[]): LoadedRegistry {
  const seenIds = new Set<string>();
  const all: RegistryEntry[] = [];

  for (const { file, data } of raws) {
    const parsed = registryEntrySchema.safeParse(data);
    if (!parsed.success) {
      throw new RegistryValidationError(file, parsed.error);
    }

    const entry =
      parsed.data.kind === "connector"
        ? normalizeConnectorAuth(parsed.data)
        : parsed.data;
    if (seenIds.has(entry.id)) {
      throw new RegistryValidationError(
        file,
        `duplicate id "${entry.id}" — every registry entry must have a unique id`,
      );
    }
    seenIds.add(entry.id);
    all.push(entry);
  }

  return indexEntries(all);
}

// Legacy `auth` → `accounts.agent` auto-mapping. Connector manifests that
// only declared `auth` keep working without edits — the resulting `accounts`
// shape lets the UI render a single agent section (backwards compatible) and
// gives downstream code a uniform field to read.
//
// The guard checks `accounts?.agent` (not just `accounts`) so that incremental
// migrations — a manifest that adds `accounts.owner` first while keeping
// `auth` as the agent credential source — still get the legacy auth mapped
// onto `accounts.agent`. A pre-existing explicit `accounts.agent` is always
// preserved.
export function normalizeConnectorAuth(entry: ConnectorEntry): ConnectorEntry {
  if (!entry.auth || entry.accounts?.agent) {
    return entry;
  }
  const authKind: AccountAuthKind = mapLegacyAuthKindToAccountAuthKind(
    entry.auth.kind,
  );
  return {
    ...entry,
    accounts: {
      ...(entry.accounts ?? {}),
      agent: {
        supported: true,
        authKind,
        credentialKeys: entry.auth.credentialKeys,
      },
    },
  };
}

// Maps the legacy four-value auth.kind enum onto the richer AccountAuthKind.
// `credentials` (username + password) is materially different from `api-key`
// (a single opaque token) but the current AccountAuthKind enum has no
// dedicated arm — both flows land on a manual paste of secret fields in the
// connector setup UI, so they coalesce here. Connectors with username+password
// flows should declare `accounts.agent.authKind` explicitly in their manifest
// when they need to distinguish, rather than relying on this auto-mapping.
function mapLegacyAuthKindToAccountAuthKind(
  kind: "token" | "oauth" | "credentials" | "none",
): AccountAuthKind {
  switch (kind) {
    case "oauth":
      return "oauth-cloud";
    case "none":
      return "none";
    case "credentials":
    case "token":
      return "api-key";
  }
}

export function indexEntries(entries: RegistryEntry[]): LoadedRegistry {
  const byId = new Map<string, RegistryEntry>();
  const byKind = new Map<RegistryKind, RegistryEntry[]>([
    ["app", []],
    ["plugin", []],
    ["connector", []],
  ]);
  const byGroup = new Map<string, RegistryEntry[]>();
  const byNpmName = new Map<string, RegistryEntry>();

  for (const entry of entries) {
    byId.set(entry.id, entry);
    byKind.get(entry.kind)?.push(entry);

    const groupBucket = byGroup.get(entry.render.group);
    if (groupBucket) {
      groupBucket.push(entry);
    } else {
      byGroup.set(entry.render.group, [entry]);
    }

    if (entry.npmName) {
      byNpmName.set(entry.npmName, entry);
    }
  }

  for (const [group, bucket] of byGroup) {
    bucket.sort(compareEntriesForDisplay);
    byGroup.set(group, bucket);
  }

  return { byId, byKind, byGroup, byNpmName, all: entries };
}

function compareEntriesForDisplay(a: RegistryEntry, b: RegistryEntry): number {
  const aOrder = a.render.groupOrder ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.render.groupOrder ?? Number.MAX_SAFE_INTEGER;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Typed kind-narrowed accessors. Keeps callers from re-asserting kind.
// ---------------------------------------------------------------------------

export function getApps(registry: LoadedRegistry): AppEntry[] {
  return (registry.byKind.get("app") ?? []) as AppEntry[];
}

export function getPlugins(registry: LoadedRegistry): PluginEntry[] {
  return (registry.byKind.get("plugin") ?? []) as PluginEntry[];
}

export function getConnectors(registry: LoadedRegistry): ConnectorEntry[] {
  return (registry.byKind.get("connector") ?? []) as ConnectorEntry[];
}

export function getEntry(
  registry: LoadedRegistry,
  id: string,
): RegistryEntry | undefined {
  return registry.byId.get(id);
}

export function getEntryByNpmName(
  registry: LoadedRegistry,
  npmName: string,
): RegistryEntry | undefined {
  return registry.byNpmName.get(npmName);
}

// ---------------------------------------------------------------------------
// Runtime overlay merge. The API calls this once per request after fetching
// runtime state. Static registry stays pure.
// ---------------------------------------------------------------------------

export function mergeWithRuntime(
  entries: RegistryEntry[],
  overlays: RegistryRuntimeOverlay[],
): RegistryView[] {
  const overlayById = new Map(overlays.map((o) => [o.id, o]));
  return entries.map((entry) => {
    const overlay = overlayById.get(entry.id) ?? defaultOverlay(entry.id);
    return { ...entry, ...overlay };
  });
}

function defaultOverlay(id: string): RegistryRuntimeOverlay {
  return {
    id,
    enabled: false,
    configured: false,
    isActive: false,
    validationErrors: [],
    validationWarnings: [],
  };
}
