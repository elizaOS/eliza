#!/usr/bin/env bun
// Bulk-applies the rate-limited Renovate dashboard updates across every
// package.json in the workspace. Only bumps versions UP. Safe to re-run.
//
// Skips:
//   - workspace:* / catalog: / file: / link: / portal: / git: / npm: / *
//   - any case where the existing min-version is already >= target
//
// Preserves the existing range prefix (^, ~, exact, >=). Two-digit forms like
//   "^25.0.6" stay caret; "~3.4.1" stays tilde; "5.9.3" stays exact pin.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// [name, target] — the version Renovate proposed.
const UPDATES = [
  // patch / minor
  ["pepr", "1.1.7"],
  ["@capacitor/core", "8.3.1"],
  ["@types/node", "22.19.17"],
  ["@walletconnect/types", "2.23.9"],
  ["@walletconnect/universal-provider", "2.23.9"],
  ["@walletconnect/utils", "2.23.9"],
  ["dompurify", "3.4.2"],
  ["esbuild", "0.28.0"],
  ["eslint-plugin-react-refresh", "0.5.0"],
  ["express-rate-limit", "8.4.1"],
  ["fast-xml-parser", "5.7.2"],
  ["ioredis", "5.10.1"],
  ["lodash-es", "4.18.1"],
  ["pino-std-serializers", "7.1.0"],
  ["prettier", "3.8.3"],
  ["rollup", "4.60.2"],
  ["tsdown", "0.21.10"],
  ["typedoc", "0.28.19"],
  ["typedoc-plugin-markdown", "4.11.0"],
  ["typescript", "6.0.0"], // major bump per dashboard
  ["undici", "8.0.0"],
  ["vitest", "4.0.0"],
  ["@vitest/coverage-v8", "4.0.0"],
  ["@atproto/api", "0.19.0"],
  ["@atproto/lexicon", "0.6.0"],
  ["@atproto/syntax", "0.5.0"],
  ["@atproto/xrpc", "0.7.0"],
  ["@coral-xyz/anchor", "0.32.1"],
  ["@discordjs/rest", "2.6.1"],
  ["@discordjs/voice", "0.19.2"],
  ["@electric-sql/pglite", "0.4.0"],
  ["@meteora-ag/dlmm", "1.9.7"],
  ["@orca-so/whirlpools", "7.0.0"],
  ["@orca-so/whirlpools-client", "6.0.0"],
  ["@orca-so/whirlpools-core", "3.0.0"],
  ["@orca-so/whirlpools-sdk", "0.20.0"],
  ["@phala/dstack-sdk", "0.5.7"],
  ["@solana-program/memo", "0.11.0"],
  ["@solana-program/system", "0.12.0"],
  ["@solana-program/token", "0.13.0"],
  ["@solana/web3.js", "1.98.4"],
  ["@tavily/core", "0.7.0"],
  ["@upstash/redis", "1.37.0"],
  ["@xmtp/node-sdk", "6.0.0"],
  ["axios", "1.16.0"],
  ["discord-api-types", "0.38.0"],
  ["discord.js", "14.26.4"],
  ["ffmpeg-static", "5.3.0"],
  ["libsodium-wrappers", "0.8.0"],
  ["lucide-react", "1.0.0"],
  ["monaco-editor", "0.55.0"],
  ["nodejs-whisper", "0.3.0"],
  ["pumpdotfun-sdk", "1.4.2"],
  ["telegram", "2.26.22"],
  ["three", "0.184.0"],
  ["@types/three", "0.184.0"],
  ["tsup", "8.5.1"],
  ["vec3", "0.2.0"],
  ["youtube-dl-exec", "3.1.5"],
  ["eslint-plugin-react-hooks", "5.0.0"],
  ["pino", "10.3.1"],
  ["@lifi/data-types", "6.0.0"],

  // major
  ["@biomejs/biome", "2.4.14"],
  ["@types/uuid", "11.0.0"],
  ["base-x", "5.0.0"],
  ["dotenv", "17.0.0"],
  ["jsdom", "29.0.0"],
  ["n8n-nodes-base", "2.0.0"],
  ["rimraf", "6.0.0"],
  ["sonic-boom", "5.0.0"],
  ["tailwindcss", "4.0.0"],
  ["thread-stream", "4.0.0"],
  ["vite-tsconfig-paths", "6.0.0"],
  ["whatwg-url", "16.0.0"],
  ["eslint", "10.0.0"],
  ["@eslint/js", "10.0.0"],
  ["jest", "30.0.0"],
  ["@types/jest", "30.0.0"],
  ["@typescript-eslint/eslint-plugin", "8.0.0"],
  ["@typescript-eslint/parser", "8.0.0"],
  ["@huggingface/transformers", "4.0.0"],
  ["@kamino-finance/kliquidity-sdk", "12.0.0"],
  ["@line/bot-sdk", "11.0.0"],
  ["@linear/sdk", "83.0.0"],
  ["@solana/kit", "6.0.0"],
  ["@steerprotocol/sdk", "3.0.0"],
  ["@stripe/react-stripe-js", "6.0.0"],
  ["@stripe/stripe-js", "9.0.0"],
  // @telegraf/types deliberately pinned to ^7.1.0 in plugin-telegram —
  // matches the bundled types for telegraf@4.16.3. Bumping to v9 caused
  // type conflicts in scenario-runner. Re-add once telegraf itself is bumped.
  // ['@telegraf/types', '9.0.0'],
  ["@twurple/auth", "8.0.0"],
  ["@twurple/chat", "8.0.0"],
  ["@types/nodemailer", "8.0.0"],
  ["@uniswap/sdk-core", "7.0.0"],
  ["@uniswap/smart-order-router", "4.0.0"],
  ["@vitejs/plugin-react", "6.0.0"],
  ["bignumber.js", "11.0.0"],
  ["bs58", "6.0.0"],
  ["commander", "14.0.0"],
  ["file-type", "22.0.0"],
  ["google-auth-library", "10.0.0"],
  ["headers-polyfill", "5.0.0"],
  ["isomorphic-dompurify", "3.0.0"],
  ["jose", "6.0.0"],
  ["lowlight", "3.0.0"],
  ["react-helmet-async", "3.0.0"],
  ["react-router-dom", "7.0.0"],
  ["redis", "5.0.0"],
  ["streamdown", "2.0.0"],
  ["stripe", "22.0.0"],
  ["tailwind-merge", "3.0.0"],
  ["tesseract.js", "7.0.0"],
  ["wagmi", "3.0.0"],
  ["zod", "4.4.2"],
  ["zod3", "4.0.0"],
];

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function shouldSkipExisting(value) {
  if (typeof value !== "string") return true;
  if (value.startsWith("workspace:")) return true;
  if (value.startsWith("catalog:")) return true;
  if (value.startsWith("file:")) return true;
  if (value.startsWith("link:")) return true;
  if (value.startsWith("portal:")) return true;
  if (value.startsWith("git+") || value.startsWith("git:")) return true;
  if (value.includes("://")) return true;
  if (value.startsWith("npm:")) return true;
  if (value === "*" || value === "latest" || value === "next") return true;
  return false;
}

// Extract the minimum semver baseline from a range string.
// "^25.0.6" -> "25.0.6"; "~3.4.1" -> "3.4.1"; "5.9.3" -> "5.9.3";
// ">=4.5.0" -> "4.5.0"; ">=4.5 <5" -> "4.5.0"
function extractMinVersion(range) {
  const m = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  return [major, minor, patch];
}

function semverGte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function newVersionString(oldVal, target) {
  let prefix = "";
  if (oldVal.startsWith("^")) prefix = "^";
  else if (oldVal.startsWith("~")) prefix = "~";
  else if (oldVal.startsWith(">=")) prefix = ">=";
  else prefix = "^"; // promote exact pins to caret on bump
  return `${prefix}${target}`;
}

function findPackageJsonFiles() {
  const out = execSync('git ls-files "*package.json"', { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.includes("/node_modules/"));
}

const updateMap = new Map(UPDATES.map(([n, v]) => [n, extractMinVersion(v)]));
const stats = {
  filesScanned: 0,
  filesChanged: 0,
  depsBumped: 0,
  skippedAlreadyNewer: 0,
  perPkg: {},
};

const files = findPackageJsonFiles();
for (const file of files) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    continue;
  }
  // Detect indent style from the first indented line.
  // Tab-indented files must stay tab-indented; space-indented files keep
  // their existing space width. Defaulting to 2 is only a last resort.
  const tabMatch = raw.match(/\n(\t+)/);
  const spaceMatch = raw.match(/\n( {2,})/);
  const indent = tabMatch ? "\t" : spaceMatch ? spaceMatch[1].length : 2;
  const trailingNl = raw.endsWith("\n");

  let changed = false;
  for (const section of SECTIONS) {
    const deps = parsed[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, target] of UPDATES) {
      if (!(name in deps)) continue;
      const cur = deps[name];
      if (shouldSkipExisting(cur)) continue;
      const curMin = extractMinVersion(cur);
      const tgtMin = updateMap.get(name);
      if (!curMin || !tgtMin) continue;
      if (semverGte(curMin, tgtMin)) {
        stats.skippedAlreadyNewer++;
        continue;
      }
      const next = newVersionString(cur, target);
      if (cur === next) continue;
      deps[name] = next;
      changed = true;
      stats.depsBumped++;
      stats.perPkg[name] = (stats.perPkg[name] || 0) + 1;
    }
  }
  stats.filesScanned++;
  if (changed) {
    const out = JSON.stringify(parsed, null, indent) + (trailingNl ? "\n" : "");
    writeFileSync(file, out);
    stats.filesChanged++;
  }
}

console.log(JSON.stringify(stats, null, 2));
