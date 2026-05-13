#!/usr/bin/env node
/**
 * Replace `bigint-buffer/dist/node.js` with a pure-JS implementation.
 *
 * `bigint-buffer@1.1.5` ships a native binding (`build/Release/bigint_buffer.node`)
 * that, on load, calls libuv's `uv_version_string`. Bun (≤ 1.3.x) does not
 * implement that function and panics, taking the embedded local agent down at
 * boot whenever a Solana / SPL-token codepath drags this module in.
 *
 * Bun bug: https://github.com/oven-sh/bun/issues/18546
 *
 * The package's own `dist/browser.js` is a pure-JS fallback (BigInt + hex). We
 * overwrite `dist/node.js` with the same logic so `require('bigint-buffer')`
 * never tries to dlopen the native binding. Performance impact is negligible
 * for the volumes Solana uses here.
 *
 * Idempotent: detects the patched header and exits early.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const PATCHED_MARKER = "// Patched: skip the native binding. Bun's libuv shim";

const PATCH = `'use strict';

// Patched: skip the native binding. Bun's libuv shim does not implement
// \`uv_version_string\` and crashes when it tries to dlopen
// \`build/Release/bigint_buffer.node\` (see bun#18546). The pure-JS path
// from \`dist/browser.js\` is a safe fallback on every runtime; the native
// binding only existed for ~2x toBigInt/fromBigInt throughput in heavy
// loops. Solana, the only consumer in this tree, does not need that.

Object.defineProperty(exports, "__esModule", { value: true });

function toBigIntLE(buf) {
  const reversed = Buffer.from(buf);
  reversed.reverse();
  const hex = reversed.toString('hex');
  if (hex.length === 0) {
    return BigInt(0);
  }
  return BigInt('0x' + hex);
}
exports.toBigIntLE = toBigIntLE;

function toBigIntBE(buf) {
  const hex = buf.toString('hex');
  if (hex.length === 0) {
    return BigInt(0);
  }
  return BigInt('0x' + hex);
}
exports.toBigIntBE = toBigIntBE;

function toBufferLE(num, width) {
  const hex = num.toString(16);
  const buffer = Buffer.from(
    hex.padStart(width * 2, '0').slice(0, width * 2),
    'hex',
  );
  buffer.reverse();
  return buffer;
}
exports.toBufferLE = toBufferLE;

function toBufferBE(num, width) {
  const hex = num.toString(16);
  return Buffer.from(
    hex.padStart(width * 2, '0').slice(0, width * 2),
    'hex',
  );
}
exports.toBufferBE = toBufferBE;
`;

function* bigintBufferRoots() {
  const bunDir = join(repoRoot, "node_modules", ".bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("bigint-buffer@")) continue;
      const pkg = join(bunDir, entry, "node_modules", "bigint-buffer");
      if (existsSync(join(pkg, "package.json"))) yield pkg;
    }
  }
  const hoisted = join(repoRoot, "node_modules", "bigint-buffer");
  if (existsSync(join(hoisted, "package.json"))) yield hoisted;
}

function alreadyPatched(pkgRoot) {
  const target = join(pkgRoot, "dist", "node.js");
  if (!existsSync(target)) return false;
  return readFileSync(target, "utf8").includes(PATCHED_MARKER);
}

function main() {
  let applied = 0;
  for (const pkgRoot of bigintBufferRoots()) {
    if (alreadyPatched(pkgRoot)) continue;
    const target = join(pkgRoot, "dist", "node.js");
    if (!existsSync(target)) continue;
    writeFileSync(target, PATCH, "utf8");
    applied += 1;
  }
  if (applied > 0) {
    console.log(`[patch-bigint-buffer] patched ${applied} install(s)`);
  }
}

main();
