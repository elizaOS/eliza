#!/usr/bin/env node
/**
 * One-off generator: produces bun-style patch files for every `@solana/*@5.x`
 * package whose `peerDependencies.typescript` is `"^5.0.0"`. Rewrites the peer
 * range to `">=5.0.0"` so TypeScript 6 satisfies it.
 *
 * The runtime postinstall (`patch-solana-ts-peer.mjs`) handles already-installed
 * trees, but it runs *after* bun's resolution warnings fire on a cold install.
 * Registering patches in `patchedDependencies` makes bun apply them during
 * extract, which silences the warnings.
 *
 * Run this once after a fresh install. It writes patch files into `patches/`
 * and prints the JSON entries to add to `patchedDependencies`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const bunDir = join(repoRoot, "node_modules", ".bun");
const patchesDir = join(repoRoot, "patches");
mkdirSync(patchesDir, { recursive: true });

function gitBlobHash(content) {
  const buf = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${buf.length}\0`);
  return createHash("sha1").update(Buffer.concat([header, buf])).digest("hex");
}

const entries = readdirSync(bunDir).filter((e) => e.startsWith("@solana+"));
const seen = new Set();
const patchedDeps = {};

for (const entry of entries) {
  const match = entry.match(/^@solana\+([^@]+)@([^+]+)/);
  if (!match) continue;
  const [, name, version] = match;
  if (!version.startsWith("5.")) continue;
  const key = `@solana/${name}@${version}`;
  if (seen.has(key)) continue;
  const pkgPath = join(bunDir, entry, "node_modules", "@solana", name, "package.json");
  if (!existsSync(pkgPath)) continue;
  const original = readFileSync(pkgPath, "utf8");
  const parsed = JSON.parse(original);
  if (parsed.peerDependencies?.typescript !== "^5.0.0") continue;
  seen.add(key);

  // Rewrite without disturbing surrounding formatting: precise string replace.
  const modified = original.replace('"typescript": "^5.0.0"', '"typescript": ">=5.0.0"');
  if (modified === original) continue;

  const origHash = gitBlobHash(original);
  const newHash = gitBlobHash(modified);

  // Unified diff: change is a single line in peerDependencies. Provide 3 lines
  // of context above and below to match git's default. Find line index.
  const origLines = original.split("\n");
  const newLines = modified.split("\n");
  let lineIdx = -1;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i] !== newLines[i]) {
      lineIdx = i;
      break;
    }
  }
  if (lineIdx < 0) continue;
  const ctxStart = Math.max(0, lineIdx - 3);
  const ctxEnd = Math.min(origLines.length - 1, lineIdx + 3);
  const oldHunk = origLines.slice(ctxStart, ctxEnd + 1);
  const newHunk = newLines.slice(ctxStart, ctxEnd + 1);

  let hunk = `@@ -${ctxStart + 1},${oldHunk.length} +${ctxStart + 1},${newHunk.length} @@\n`;
  for (let i = 0; i < oldHunk.length; i++) {
    if (i === lineIdx - ctxStart) {
      hunk += `-${oldHunk[i]}\n`;
      hunk += `+${newHunk[i]}\n`;
    } else {
      hunk += ` ${oldHunk[i]}\n`;
    }
  }

  const patch =
    `diff --git a/package.json b/package.json\n` +
    `index ${origHash}..${newHash} 100644\n` +
    `--- a/package.json\n` +
    `+++ b/package.json\n` +
    hunk;

  const fileName = `@solana%2F${name}@${version}.patch`;
  writeFileSync(join(patchesDir, fileName), patch);
  patchedDeps[key] = `patches/${fileName}`;
}

console.log(JSON.stringify(patchedDeps, null, 2));
console.error(`[generate-solana-ts-patches] wrote ${Object.keys(patchedDeps).length} patches`);
