/**
 * First-party registry aggregator — the build-time generator behind the
 * `generate:first-party` script.
 *
 * Registration is plugin-side: each in-repo plugin/package owns its registry
 * entry as a `registry-entry.json` in its own directory (a single entry object,
 * or an array of entries). Curated entries with no vendored package — built-in
 * app-viewers and entries for plugins not checked out in this repo — live under
 * `curated/`. This script gathers all of them, validates each fail-loud against
 * the Zod schema, dedupes by id, and writes the aggregated `generated.json` that
 * the runtime loader reads (a single committed artifact, trivial to stage
 * alongside an on-device bundle), plus the derived curated-app / channel /
 * provider maps. `--check` re-runs the generator and fails on drift for CI.
 *
 *   bun run --cwd packages/registry generate:first-party           # rewrite generated.json
 *   bun run --cwd packages/registry generate:first-party --check   # CI drift gate
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RegistryEntry, registryEntrySchema } from "./schema";

// Resolve biome from the repo-root package.json, not this file: this package
// doesn't declare @biomejs/biome, so under isolated installs resolving from
// here walks up PAST the repo into whatever stale copy a parent workspace
// hoisted — version-skewed against biome.json's pinned schema.
const rootRequire = createRequire(
  new URL("../../../../package.json", import.meta.url),
);

// `JSON.stringify(…, null, 2)` puts every array element on its own line, but
// biome — the repo's format gate (`bun run format:check`) — collapses arrays
// that fit onto a single line. Without reconciling the two, the committed
// artifacts can only satisfy one gate at a time, and a later `registry build`
// (which re-runs this generator) silently re-breaks the biome gate. Piping each
// artifact through biome makes the generator emit exactly what `format:check`
// expects, so generator output, committed files, and the format gate all agree.
function biomeFormatJson(content: string, filePath: string): string {
  const biomeBin = rootRequire.resolve("@biomejs/biome/bin/biome");
  return execFileSync(
    process.execPath,
    [biomeBin, "format", `--stdin-file-path=${filePath}`],
    { input: content, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CURATED_DIR = join(HERE, "curated");
const GENERATED_PATH = join(HERE, "generated.json");
// Small derived artifact: just the curated-app definitions (slug, canonicalName,
// aliases), ordered. `@elizaos/shared` statically imports this (browser-safe, no
// fs) to materialize ELIZA_CURATED_APP_DEFINITIONS without bundling the full
// registry. Regenerated alongside generated.json.
const CURATED_DEFS_PATH = join(HERE, "curated-app-definitions.json");
// Derived channel -> plugin-package map. agent + app-core statically import this
// (browser-safe, no fs) instead of hand-maintaining duplicate CHANNEL_PLUGIN_MAPs.
const CHANNEL_MAP_PATH = join(HERE, "channel-plugin-map.json");
// Derived env-key -> provider plugin package map. The agent statically imports
// this instead of hand-maintaining PROVIDER_PLUGIN_MAP. Entries opt in by
// marking config fields with `autoEnableProvider: true`.
const PROVIDER_MAP_PATH = join(HERE, "provider-plugin-map.json");

interface CuratedAppDefinition {
  slug: string;
  canonicalName: string;
  aliases: string[];
}

export function collectCuratedAppDefinitions(
  entries: RegistryEntry[],
): CuratedAppDefinition[] {
  return entries
    .filter((e) => Boolean(e.curatedApp))
    .sort((a, b) => (a.curatedApp?.order ?? 0) - (b.curatedApp?.order ?? 0))
    .map((e) => ({
      slug: e.curatedApp?.slug ?? "",
      // canonicalName is the entry's npm package; every curated entry declares one.
      canonicalName: e.npmName ?? "",
      aliases: e.curatedApp?.aliases ?? [],
    }));
}

// Derive the channel -> plugin-package map from connector entries' `channels`.
// This replaces the hand-maintained CHANNEL_PLUGIN_MAP duplicated in agent +
// app-core. Keys are sorted for a stable artifact; consumers read by key.
export function collectChannelPluginMap(
  entries: RegistryEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (!e.npmName) continue;
    for (const channel of e.channels ?? []) {
      if (map[channel] && map[channel] !== e.npmName) {
        throw new Error(
          `[registry/generate] channel "${channel}" claimed by both ${map[channel]} and ${e.npmName}`,
        );
      }
      map[channel] = e.npmName;
    }
  }
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]]),
  );
}

export function collectProviderPluginMap(
  entries: RegistryEntry[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (!e.npmName) continue;
    for (const [envKey, field] of Object.entries(e.config ?? {})) {
      if (field.autoEnableProvider !== true) continue;
      if (map[envKey] && map[envKey] !== e.npmName) {
        throw new Error(
          `[registry/generate] provider env key "${envKey}" claimed by both ${map[envKey]} and ${e.npmName}`,
        );
      }
      map[envKey] = e.npmName;
    }
  }
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]]),
  );
}

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

export function generateFirstPartyRegistry(): {
  full: string;
  curated: string;
  channels: string;
  providers: string;
} {
  const entries = collectFirstPartyEntries();
  return {
    full: `${JSON.stringify({ entries }, null, 2)}\n`,
    curated: `${JSON.stringify(collectCuratedAppDefinitions(entries), null, 2)}\n`,
    channels: `${JSON.stringify(collectChannelPluginMap(entries), null, 2)}\n`,
    providers: `${JSON.stringify(collectProviderPluginMap(entries), null, 2)}\n`,
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = generateFirstPartyRegistry();
  const artifacts: [string, string][] = [
    [GENERATED_PATH, biomeFormatJson(next.full, GENERATED_PATH)],
    [CURATED_DEFS_PATH, biomeFormatJson(next.curated, CURATED_DEFS_PATH)],
    [CHANNEL_MAP_PATH, biomeFormatJson(next.channels, CHANNEL_MAP_PATH)],
    [PROVIDER_MAP_PATH, biomeFormatJson(next.providers, PROVIDER_MAP_PATH)],
  ];
  if (check) {
    for (const [path, expected] of artifacts) {
      const current =
        existsSync(path) && statSync(path).isFile()
          ? readFileSync(path, "utf-8")
          : "";
      if (current !== expected) {
        console.error(
          `[registry/generate] ${path} is stale. Run \`bun run --cwd packages/registry generate:first-party\` and commit the result.`,
        );
        process.exit(1);
      }
    }
    console.log("[registry/generate] generated artifacts are up to date.");
    return;
  }
  for (const [path, content] of artifacts) writeFileSync(path, content);
  const count = JSON.parse(next.full).entries.length;
  const curatedCount = JSON.parse(next.curated).length;
  console.log(
    `[registry/generate] wrote ${count} entries + ${curatedCount} curated-app definitions`,
  );
}

if (import.meta.main) {
  main();
}
