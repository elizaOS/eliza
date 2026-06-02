/**
 * Generate `generated-registry.json` — the wire format the runtime fetches —
 * from the source `entries/third-party/*.json` files.
 *
 * Run directly (`bun run src/generate.ts`) to regenerate the committed output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadThirdPartyEntries } from "./loader.ts";
import type {
  GeneratedRegistry,
  GeneratedRegistryEntry,
  RegistryEntry,
} from "./types.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OUTPUT_PATH = path.join(packageRoot, "generated-registry.json");

function repoSlug(repository: string): string {
  return repository.replace(/^github:/, "");
}

/** Map one source entry into its wire-format counterpart. */
export function toGeneratedEntry(entry: RegistryEntry): GeneratedRegistryEntry {
  return {
    git: {
      repo: repoSlug(entry.repository),
      v0: { branch: null },
      v1: { branch: null },
      v2: { branch: "main" },
    },
    npm: {
      repo: entry.package,
      v0: null,
      v1: null,
      v2: entry.version ?? null,
    },
    supports: { v0: false, v1: false, v2: true },
    description: entry.description ?? "",
    homepage: entry.homepage ?? null,
    topics: entry.tags ?? [],
    stargazers_count: 0,
    language: "TypeScript",
    origin: "third-party",
    source: "community",
    support: "community",
    builtIn: false,
    firstParty: false,
    thirdParty: true,
    kind: entry.kind,
    registryKind: entry.kind,
    directory: entry.directory ?? null,
  };
}

/** Build the full wire registry from the source entries on disk. */
export function generateRegistry(
  entries = loadThirdPartyEntries(),
): GeneratedRegistry {
  const registry: Record<string, GeneratedRegistryEntry> = {};
  for (const entry of entries) {
    registry[entry.package] = toGeneratedEntry(entry);
  }
  return { registry };
}

function main(): void {
  const registry = generateRegistry();
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  const count = Object.keys(registry.registry).length;
  console.log(`Generated ${OUTPUT_PATH} (${count} third-party entries)`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  main();
}
