// Runtime entry point. Reads JSON entries from data/, validates, caches, and
// exposes typed accessors. The single import path the rest of the codebase
// uses to consume the registry.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedRegistry, loadRegistryFromRawEntries } from "./loader";

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

// Bun.build collapses these top-level `const` declarations into `var`s
// inside an `__esm` wrapper, and `import.meta.url` inside that wrapper
// can resolve to `undefined` on the on-device runtime when the registry
// module is initialised through the `Promise.resolve().then(() => init_xxx())`
// adapter the bundler emits for dynamic-import re-exports of `@elizaos/app-core`.
// The fallback to `process.argv[1]` matches the bundle's own entrypoint
// (e.g. `/data/data/.../agent-bundle.js`) so the registry sits at
// `<bundle-dir>/entries/`. Phase A asset extraction stages the `entries/`
// payload alongside the bundle.
function resolveEntriesDir(): string {
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
  const distEntries = join(moduleDir, "entries");
  // When running from a freshly-cloned workspace (dist/ not built yet) the
  // module sits at `packages/app-core/dist/registry/index.js` but the entries
  // haven't been copied across yet. Fall back to the colocated source tree at
  // `packages/app-core/src/registry/entries/` so dev boots survive missing
  // builds. Packaged builds (where moduleDir resolves under .../dist/...) and
  // the on-device runtime (where there is no `src/` sibling) keep using
  // `distEntries` as before.
  if (!existsSync(distEntries)) {
    const sourceFallback = resolve(
      moduleDir,
      "..",
      "..",
      "src",
      "registry",
      "entries",
    );
    if (existsSync(sourceFallback)) {
      return sourceFallback;
    }
  }
  return distEntries;
}

let cache: LoadedRegistry | null = null;

export function loadRegistry(): LoadedRegistry {
  if (cache) return cache;

  const entriesDir = resolveEntriesDir();
  const raws: { file: string; data: unknown }[] = [];
  for (const kind of ["apps", "plugins", "connectors"] as const) {
    const kindDir = join(entriesDir, kind);
    let entries: string[];
    try {
      entries = readdirSync(kindDir);
    } catch {
      // In packaged desktop builds the registry entries may not be bundled.
      // Log and continue rather than crashing the agent subprocess.
      console.warn(`[registry] ${kind} directory missing: ${kindDir}`);
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
