// Runtime entry point. Reads JSON entries from data/, validates, caches, and
// exposes typed accessors. The single import path the rest of the codebase
// uses to consume the registry.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedRegistry, loadRegistryFromRawEntries } from "./loader";

export {
  entriesToLegacyManifest,
  entryToLegacyManifestEntry,
  type LegacyManifest,
  type LegacyManifestEntry,
  type LegacyManifestParameter,
} from "./legacy-adapter";
export {
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  type LoadedRegistry,
  mergeWithRuntime,
  type RegistryValidationError,
} from "./loader";
export * from "./schema";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const entriesDir = join(moduleDir, "entries");

let cache: LoadedRegistry | null = null;

export function loadRegistry(): LoadedRegistry {
  if (cache) return cache;

  const raws: { file: string; data: unknown }[] = [];
  for (const kind of ["apps", "plugins", "connectors"] as const) {
    const kindDir = join(entriesDir, kind);
    // Fail loud if a kind directory is missing — the registry is the source
    // for /api/plugins and /api/catalog/apps; silently dropping a kind would
    // surface as an empty catalog at runtime instead of a clear bundle bug.
    const entries = readdirSync(kindDir);
    for (const filename of entries) {
      if (!filename.endsWith(".json")) continue;
      const file = join(kindDir, filename);
      const data = JSON.parse(readFileSync(file, "utf-8"));
      raws.push({ file, data });
    }
  }

  cache = loadRegistryFromRawEntries(raws);
  return cache;
}

export function clearRegistryCacheForTests(): void {
  cache = null;
}
