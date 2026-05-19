#!/usr/bin/env node
/**
 * patch-bigint-buffer-warning.mjs
 *
 * `bigint-buffer@1.1.5` (a transitive Solana dep) emits a noisy
 * `bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)`
 * warning on every process start when the optional native binding fails to
 * load. The pure-JS fallback works fine for our usage, so the warning is
 * pure log spam during `bun run test` across many packages.
 *
 * This script idempotently rewrites every `bigint-buffer/dist/node.js` it can
 * find under `node_modules/` so the warning is gated behind
 * `ELIZA_DEBUG_BIGINT_BINDINGS=1`. Set that env var when you actually want to
 * debug the native binding load failure.
 *
 * The file is replaced with a canonical version derived from upstream
 * `bigint-buffer@1.1.5/dist/node.js` so repeated runs cannot accumulate
 * duplicate guards (which has happened historically with hand-edits).
 */

import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL = `'use strict';

Object.defineProperty(exports, "__esModule", { value: true });
let converter;
{
    try {
        converter = require('bindings')('bigint_buffer');
    }
    catch (e) {
        if (process.env.ELIZA_DEBUG_BIGINT_BINDINGS === "1") {
            console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');
        }
    }
}
function toBigIntLE(buf) {
    if (converter === undefined) {
        const reversed = Buffer.from(buf);
        reversed.reverse();
        const hex = reversed.toString('hex');
        if (hex.length === 0) {
            return BigInt(0);
        }
        return BigInt(\`0x\${hex}\`);
    }
    return converter.toBigInt(buf, false);
}
exports.toBigIntLE = toBigIntLE;
function toBigIntBE(buf) {
    if (converter === undefined) {
        const hex = buf.toString('hex');
        if (hex.length === 0) {
            return BigInt(0);
        }
        return BigInt(\`0x\${hex}\`);
    }
    return converter.toBigInt(buf, true);
}
exports.toBigIntBE = toBigIntBE;
function toBufferLE(num, width) {
    if (converter === undefined) {
        const hex = num.toString(16);
        const buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
        buffer.reverse();
        return buffer;
    }
    return converter.fromBigInt(num, Buffer.allocUnsafe(width), false);
}
exports.toBufferLE = toBufferLE;
function toBufferBE(num, width) {
    if (converter === undefined) {
        const hex = num.toString(16);
        return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
    }
    return converter.fromBigInt(num, Buffer.allocUnsafe(width), true);
}
exports.toBufferBE = toBufferBE;
`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP_DIRS = new Set([".git", ".cache", "dist", "build", ".next", ".turbo", "coverage", "__pycache__"]);

function findBigintBufferNodeJs(startDir, results = [], depth = 0) {
  if (depth > 15) return results;
  let entries;
  try {
    entries = readdirSync(startDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(startDir, entry.name);
    if (entry.name === "bigint-buffer") {
      const candidate = join(full, "dist", "node.js");
      if (existsSync(candidate)) results.push(candidate);
      continue;
    }
    findBigintBufferNodeJs(full, results, depth + 1);
  }
  return results;
}

const searchRoots = [join(repoRoot, "node_modules"), join(repoRoot, "packages")];
const targets = [];
for (const root of searchRoots) {
  findBigintBufferNodeJs(root, targets);
}

let rewritten = 0;
let alreadyClean = 0;
for (const file of targets) {
  let current;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (current === CANONICAL) {
    alreadyClean += 1;
    continue;
  }
  writeFileSync(file, CANONICAL, "utf8");
  rewritten += 1;
}

if (targets.length > 0) {
  console.log(
    `[patch-bigint-buffer-warning] checked ${targets.length} file(s); rewrote ${rewritten}, already clean ${alreadyClean}.`
  );
}
