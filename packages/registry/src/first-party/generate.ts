// First-party registry aggregator.
//
// Registration is plugin-side: each in-repo plugin/package owns its registry
// entry as a `registry-entry.json` in its own directory (a single entry object,
// or an array of entries). Curated entries with no vendored package — built-in
// app-viewers and entries for plugins not checked out in this repo — live under
// `curated/`. This script gathers all of them, validates each fail-loud against
// the Zod schema, dedupes by id, and writes the aggregated `generated.json` that
// the runtime loader reads (a single committed artifact, trivial to stage
// alongside an on-device bundle).
//
//   bun run --cwd packages/registry generate:first-party   # rewrite generated.json
//   bun run --cwd packages/registry generate:first-party --check   # CI drift gate

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RegistryEntry, registryEntrySchema } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CURATED_DIR = join(HERE, "curated");
const GENERATED_PATH = join(HERE, "generated.json");

interface SourcedEntry {
  entry: RegistryEntry;
  file: string;
}

function readEntryFile(file: string): SourcedEntry[] {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.map((data) => {
    const parsed = registryEntrySchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `[registry/generate] ${file} failed validation: ${String(parsed.error)}`,
      );
    }
    return { entry: parsed.data, file };
  });
}

function collectPluginOwnedEntries(): SourcedEntry[] {
  const out: SourcedEntry[] = [];
  for (const base of ["plugins", "packages"]) {
    const baseDir = join(REPO_ROOT, base);
    if (!existsSync(baseDir)) continue;
    for (const dirent of readdirSync(baseDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const file = join(baseDir, dirent.name, "registry-entry.json");
      if (existsSync(file)) out.push(...readEntryFile(file));
    }
  }
  return out;
}

function collectCuratedEntries(): SourcedEntry[] {
  const out: SourcedEntry[] = [];
  if (!existsSync(CURATED_DIR)) return out;
  const walk = (dir: string) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.name.endsWith(".json")) {
        out.push(...readEntryFile(full));
      }
    }
  };
  walk(CURATED_DIR);
  return out;
}

export function collectFirstPartyEntries(): RegistryEntry[] {
  const sourced = [...collectPluginOwnedEntries(), ...collectCuratedEntries()];
  const byId = new Map<string, string>();
  for (const { entry, file } of sourced) {
    const existing = byId.get(entry.id);
    if (existing) {
      throw new Error(
        `[registry/generate] duplicate id "${entry.id}" in ${file} and ${existing}`,
      );
    }
    byId.set(entry.id, file);
  }
  return sourced.map((s) => s.entry).sort((a, b) => a.id.localeCompare(b.id));
}

export function generateFirstPartyRegistry(): string {
  const entries = collectFirstPartyEntries();
  return `${JSON.stringify({ entries }, null, 2)}\n`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = generateFirstPartyRegistry();
  if (check) {
    const current =
      existsSync(GENERATED_PATH) && statSync(GENERATED_PATH).isFile()
        ? readFileSync(GENERATED_PATH, "utf-8")
        : "";
    if (current !== next) {
      console.error(
        "[registry/generate] generated.json is stale. Run `bun run --cwd packages/registry generate:first-party` and commit the result.",
      );
      process.exit(1);
    }
    console.log("[registry/generate] generated.json is up to date.");
    return;
  }
  writeFileSync(GENERATED_PATH, next);
  const count = JSON.parse(next).entries.length;
  console.log(`[registry/generate] wrote ${count} entries to generated.json`);
}

if (import.meta.main) {
  main();
}
