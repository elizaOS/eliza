/**
 * Read and validate the third-party registry entries on disk.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegistryEntry } from "./schema.ts";
import type { RegistryEntry } from "./types.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Absolute path to the `entries/third-party` directory. */
export function thirdPartyEntriesDir(): string {
  return path.join(packageRoot, "entries", "third-party");
}

/**
 * Load every third-party entry, validating each against the schema. Throws on
 * the first invalid file so a malformed entry never reaches the generator.
 * Entries are returned sorted by package name for deterministic output.
 */
export function loadThirdPartyEntries(
  dir = thirdPartyEntriesDir(),
): RegistryEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const seen = new Set<string>();
  const entries: RegistryEntry[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = JSON.parse(raw);
    const entry = assertRegistryEntry(parsed, file);
    if (seen.has(entry.package)) {
      throw new Error(
        `Duplicate registry entry for ${entry.package} (${file})`,
      );
    }
    seen.add(entry.package);
    entries.push(entry);
  }

  entries.sort((a, b) => a.package.localeCompare(b.package));
  return entries;
}
