#!/usr/bin/env node
/**
 * Guards the append-only Cloud migration journal against ambiguous numeric prefixes.
 *
 * The generated manifest freezes the deployed total order, including historical
 * duplicate prefixes. New entries must append after that exact prefix and use a
 * previously unseen, strictly increasing numeric prefix.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL_PATH = path.join(PACKAGE_ROOT, "src/db/migrations/meta/_journal.json");
const MANIFEST_PATH = path.join(
  PACKAGE_ROOT,
  "src/db/migrations/migration-prefix-order.manifest.json",
);

function numericPrefix(tag) {
  const match = /^(\d{4})_/.exec(tag);
  if (!match) throw new Error(`Migration tag lacks a four-digit prefix: ${tag}`);
  return Number(match[1]);
}

export function assertMigrationPrefixOrder(entries, manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.frozenJournalTags)) {
    throw new Error("Invalid migration prefix-order manifest schema");
  }
  if (entries.length < manifest.frozenJournalTags.length) {
    throw new Error("Migration journal is shorter than the frozen deployment order");
  }
  for (const [index, frozenTag] of manifest.frozenJournalTags.entries()) {
    if (entries[index]?.tag !== frozenTag) {
      throw new Error(
        `Frozen migration order drift at index ${index}: expected ${frozenTag}, found ${entries[index]?.tag ?? "missing"}`,
      );
    }
  }

  const frozenPrefixes = new Set(manifest.frozenJournalTags.map(numericPrefix));
  let lastPrefix = Math.max(...frozenPrefixes);
  for (const entry of entries.slice(manifest.frozenJournalTags.length)) {
    const prefix = numericPrefix(entry.tag);
    if (frozenPrefixes.has(prefix) || prefix <= lastPrefix) {
      throw new Error(
        `New migration ${entry.tag} must use a unique prefix greater than ${String(lastPrefix).padStart(4, "0")}`,
      );
    }
    frozenPrefixes.add(prefix);
    lastPrefix = prefix;
  }
}

export function readJournalEntries() {
  return JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).entries;
}

export function writeCurrentManifest(entries = readJournalEntries()) {
  const manifest = {
    schemaVersion: 1,
    frozenJournalTags: entries.map(({ tag }) => tag),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function checkCurrentMigrationPrefixOrder() {
  const entries = readJournalEntries();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assertMigrationPrefixOrder(entries, manifest);
}

if (process.argv.includes("--write")) writeCurrentManifest();
else checkCurrentMigrationPrefixOrder();
