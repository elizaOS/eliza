/**
 * First-party curated registry — runtime entry point.
 *
 * Reads the aggregated `generated.json`, validates, caches, and exposes typed
 * accessors. This is the single import path the rest of the codebase consumes
 * (`@elizaos/registry/first-party`, re-exported by `@elizaos/app-core/registry`
 * for backwards compatibility).
 *
 * Registration is plugin-side: bundled JSON is the default, and any plugin can
 * contribute or override an entry at runtime via `registerRegistryEntry()`
 * (deduped by `id`; runtime entries win). Resolving the generated file and the
 * cache slot are both hardened against on-device bundling and circular-import
 * re-entry (see `resolveGeneratedPath` and `cacheSlot`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  indexEntries,
  type LoadedRegistry,
  loadRegistryFromRawEntries,
  normalizeConnectorAuth,
} from "./loader";
import { type RegistryEntry, registryEntrySchema } from "./schema";

export * from "./app-registry";
export {
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  type LoadedRegistry,
  mergeWithRuntime,
  normalizeConnectorAuth,
  type RegistryValidationError,
} from "./loader";
export * from "./schema";

// Entries are aggregated at build time (see generate.ts) from plugin-owned
// `registry-entry.json` files plus the `curated/` set into a single committed
// `generated.json`. The runtime reads that one file — a single artifact that is
// trivial to stage alongside an on-device bundle.
//
// Bun.build collapses top-level `const` declarations into `var`s inside an
// `__esm` wrapper, and `import.meta.url` inside that wrapper can resolve to
// `undefined` on the on-device runtime when the module is initialised through
// the `Promise.resolve().then(() => init_xxx())` adapter the bundler emits for
// dynamic-import re-exports. The fallback to `process.argv[1]` matches the
// bundle's own entrypoint (e.g. `/data/data/.../agent-bundle.js`) so the
// registry sits at `<bundle-dir>/generated.json`.
function resolveGeneratedPath(): string {
  const url =
    typeof import.meta.url === "string" && import.meta.url
      ? import.meta.url
      : null;
  let moduleDir: string;
  if (url) {
    try {
      moduleDir = dirname(fileURLToPath(url));
    } catch {
      moduleDir = dirname(process.argv[1] ?? process.cwd());
    }
  } else {
    moduleDir = dirname(process.argv[1] ?? process.cwd());
  }
  return join(moduleDir, "generated.json");
}

// Plugin-side registration overlay. Symbol-keyed global so every consumer —
// regardless of which package instance imports this module — contributes to one
// store. Entries registered here override bundled JSON twins by `id`.
const RUNTIME_ENTRIES_KEY = Symbol.for(
  "elizaos.first-party-registry.runtime-entries",
);

function getRuntimeEntryStore(): { entries: RegistryEntry[] } {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[RUNTIME_ENTRIES_KEY] as
    | { entries: RegistryEntry[] }
    | null
    | undefined;
  if (existing) return existing;
  const created = { entries: [] as RegistryEntry[] };
  globalObject[RUNTIME_ENTRIES_KEY] = created;
  return created;
}

/**
 * Register (or override) a first-party registry entry at runtime.
 *
 * Validated fail-loud against `registryEntrySchema`, exactly like the bundled
 * JSON loader, so a malformed plugin-contributed entry can't slip in. A
 * registered entry overrides a bundled entry with the same `id`.
 */
export function registerRegistryEntry(entry: RegistryEntry): void {
  const parsed = registryEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `registerRegistryEntry: entry failed validation: ${String(parsed.error)}`,
    );
  }
  const normalized =
    parsed.data.kind === "connector"
      ? normalizeConnectorAuth(parsed.data)
      : parsed.data;
  const store = getRuntimeEntryStore();
  const idx = store.entries.findIndex((e) => e.id === normalized.id);
  if (idx >= 0) {
    store.entries[idx] = normalized;
  } else {
    store.entries.push(normalized);
  }
  // Invalidate the cache so the next loadRegistry() observes the new entry.
  if (cacheSlot) cacheSlot.value = null;
}

// TDZ-hardening: this module's cached registry slot must survive being
// re-entered during circular-import partial evaluation on Bun's strict ESM
// runtime. A bare `let cache = null` would still be in the temporal dead zone
// when an import cycle re-enters `loadRegistry()`, throwing
// `Cannot access 'cache' before initialization` and bricking boot.
var cacheSlot: { value: LoadedRegistry | null } = { value: null };

function readEntriesFromDisk(): RegistryEntry[] {
  const generatedPath = resolveGeneratedPath();
  if (!existsSync(generatedPath)) {
    // error-policy:J4 explicit designed degrade — in packaged builds the
    // aggregated registry is legitimately not bundled, so an empty first-party
    // set is a valid state (not a load failure). Warn and continue rather than
    // crashing the agent subprocess. `console` is intentional: this low-level
    // package has no `@elizaos/logger` dependency and must stay dependency-free.
    console.warn(`[registry] generated.json missing: ${generatedPath}`);
    return [];
  }
  const parsed = JSON.parse(readFileSync(generatedPath, "utf-8")) as {
    entries?: unknown[];
  };
  const raws = (parsed.entries ?? []).map((data, i) => ({
    file: `${generatedPath}#${i}`,
    data,
  }));
  return loadRegistryFromRawEntries(raws).all;
}

export function loadRegistry(): LoadedRegistry {
  // Self-heal: if a cycle re-entered us before the module-top initializer ran,
  // hoisted `cacheSlot` is `undefined`. Lazily initialize so we never throw.
  if (!cacheSlot) {
    cacheSlot = { value: null };
  }
  if (cacheSlot.value) return cacheSlot.value;

  const fileEntries = readEntriesFromDisk();
  const runtime = getRuntimeEntryStore().entries;
  if (runtime.length === 0) {
    cacheSlot.value = indexEntries(fileEntries);
    return cacheSlot.value;
  }
  // Plugin-registered entries override bundled twins by id.
  const merged = new Map(fileEntries.map((e) => [e.id, e]));
  for (const e of runtime) merged.set(e.id, e);
  cacheSlot.value = indexEntries([...merged.values()]);
  return cacheSlot.value;
}

export function clearRegistryCacheForTests(): void {
  if (!cacheSlot) {
    cacheSlot = { value: null };
    return;
  }
  cacheSlot.value = null;
}
