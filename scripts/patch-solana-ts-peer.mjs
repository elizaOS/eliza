#!/usr/bin/env node
/**
 * Loosen `peerDependencies.typescript` on `@solana/*@5.x` packages.
 *
 * Many `@solana/*` v5 packages declare `typescript: "^5.0.0"`, which spuriously
 * rejects our workspace's TypeScript 6. They build fine on TS 6 — the peer is
 * cosmetic. Rewrite `^5.0.0` → `>=5.0.0` so `bun install` is warning-free.
 *
 * Idempotent.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const bunDir = join(repoRoot, "node_modules", ".bun");

let bunEntries;
try {
  bunEntries = readdirSync(bunDir);
} catch {
  process.exit(0);
}

let patched = 0;
for (const entry of bunEntries) {
  if (!entry.startsWith("@solana+")) continue;
  const pkgPath = join(
    bunDir,
    entry,
    "node_modules",
    "@solana",
    entry.split("@")[1].split("+")[1] ?? "",
    "package.json",
  );
  // entry like "@solana+kit@5.5.1+abcd…"
  const parts = entry.match(/^@solana\+([^@]+)@([^+]+)/);
  if (!parts) continue;
  const [, name, version] = parts;
  if (!version.startsWith("5.")) continue;
  const real = join(bunDir, entry, "node_modules", "@solana", name, "package.json");
  let raw;
  try {
    raw = readFileSync(real, "utf8");
  } catch {
    continue;
  }
  const pkg = JSON.parse(raw);
  const ts = pkg.peerDependencies && pkg.peerDependencies.typescript;
  if (ts !== "^5.0.0") continue;
  pkg.peerDependencies.typescript = ">=5.0.0";
  writeFileSync(real, JSON.stringify(pkg, null, 2) + "\n");
  patched++;
}

if (patched > 0) {
  console.log(`[patch-solana-ts-peer] loosened typescript peer on ${patched} @solana/* packages`);
}
