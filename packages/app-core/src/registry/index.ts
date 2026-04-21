// Runtime entry point. Reads JSON entries from data/, validates, caches, and
// exposes typed accessors. The single import path the rest of the codebase
// uses to consume the registry.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedRegistry,
  loadRegistryFromRawEntries,
} from "./loader";

export * from "./schema";
export {
  type LoadedRegistry,
  type RegistryValidationError,
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  mergeWithRuntime,
} from "./loader";
export {
  type LegacyManifest,
  type LegacyManifestEntry,
  type LegacyManifestParameter,
  entriesToLegacyManifest,
  entryToLegacyManifestEntry,
} from "./legacy-adapter";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const entriesDir = join(moduleDir, "entries");

let cache: LoadedRegistry | null = null;

export function loadRegistry(): LoadedRegistry {
  if (cache) return cache;

  const raws: { file: string; data: unknown }[] = [];
  for (const kind of ["apps", "plugins", "connectors"] as const) {
    const kindDir = join(entriesDir, kind);
    let entries: string[];
    try {
      entries = readdirSync(kindDir);
    } catch {
      continue;
    }
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
