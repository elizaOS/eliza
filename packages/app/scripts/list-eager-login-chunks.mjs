#!/usr/bin/env node

/**
 * List JS chunks eagerly reachable from packages/app/dist/index.html.
 * Complements #18056 cold transfer measurement with a static closure list.
 *
 * Usage (after production build):
 *   node scripts/list-eager-login-chunks.mjs [--out report.json]
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const distRoot = join(appDir, "dist");
const distAssets = join(distRoot, "assets");
const indexHtmlPath = join(distRoot, "index.html");

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: appDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function collectReferencedJsFiles() {
  if (!existsSync(indexHtmlPath)) {
    throw new Error(`missing ${indexHtmlPath} — run app build first`);
  }
  const indexHtml = readFileSync(indexHtmlPath, "utf8");
  const allJs = existsSync(distAssets)
    ? readdirSync(distAssets).filter((f) => f.endsWith(".js"))
    : [];
  const referenced = new Set();
  const pending = [];

  const addAssetRef = (rawRef, fromFile = null) => {
    if (!rawRef?.endsWith(".js")) return;
    let normalized = rawRef;
    if (normalized.startsWith("/")) normalized = normalized.slice(1);
    if (normalized.startsWith("./")) {
      normalized = fromFile
        ? join(dirname(fromFile), normalized.slice(2)).replaceAll("\\", "/")
        : normalized.slice(2);
    }
    // strip query
    normalized = normalized.split("?")[0];
    if (!normalized.includes("assets/")) {
      // bare filename in assets/
      if (!normalized.includes("/")) normalized = `assets/${normalized}`;
      else return;
    }
    const file = normalized.slice(
      normalized.indexOf("assets/") + "assets/".length,
    );
    if (!file.endsWith(".js") || referenced.has(file)) return;
    if (!existsSync(join(distAssets, file))) return;
    referenced.add(file);
    pending.push(file);
  };

  for (const m of indexHtml.matchAll(/(?:src|href)=["']([^"']+\.js)["']/gi)) {
    addAssetRef(m[1]);
  }
  for (const m of indexHtml.matchAll(
    /<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/gi,
  )) {
    addAssetRef(m[1]);
  }

  // Walk static import() / import "..." edges in JS (eager graph only:
  // bare import specifiers relative/absolute to assets; skip dynamic import(var))
  while (pending.length) {
    const file = pending.pop();
    const text = readFileSync(join(distAssets, file), "utf8");
    // static: import ... from "./x.js" or from "/assets/x.js"
    for (const m of text.matchAll(
      /\bimport\s*(?:[^"'`]*?from\s*)?["']([^"']+\.js)["']/g,
    )) {
      addAssetRef(m[1], `assets/${file}`);
    }
    // export from
    for (const m of text.matchAll(
      /\bexport\s+[^"'`]*?\bfrom\s*["']([^"']+\.js)["']/g,
    )) {
      addAssetRef(m[1], `assets/${file}`);
    }
  }

  return { referenced: [...referenced].sort(), allJsCount: allJs.length };
}

function classify(name) {
  const n = name.toLowerCase();
  if (
    /vendor-crypto|vendor-wallet|vendor-solana|wagmi|viem|rainbow|walletconnect|solana/.test(
      n,
    )
  )
    return "wallet-crypto";
  if (/steward|stwd/.test(n)) return "steward";
  if (/cloud|login|register|router/.test(n)) return "cloud-shell";
  if (/i18n|locale|date-fns/.test(n)) return "i18n";
  if (/react|scheduler/.test(n)) return "react";
  return "other";
}

function main() {
  const args = parseArgs(process.argv);
  const { referenced, allJsCount } = collectReferencedJsFiles();
  const rows = referenced.map((file) => {
    const bytes = statSyncSafe(join(distAssets, file));
    return {
      file,
      bytes,
      class: classify(file),
    };
  });
  rows.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);
  const byClass = {};
  for (const r of rows) {
    byClass[r.class] = (byClass[r.class] || 0) + r.bytes;
  }

  const report = {
    issue: "18056",
    headSha: gitHead(),
    note: "Eager static import closure from index.html (not dynamic import()). File sizes are on-disk (decoded), not transferSize.",
    eagerChunkCount: rows.length,
    totalJsInAssets: allJsCount,
    totalEagerBytes: totalBytes,
    byClass,
    chunks: rows,
    capturedAtIso: new Date().toISOString(),
  };

  console.log(
    `Eager JS chunks from index.html: ${rows.length} / ${allJsCount} assets (${(totalBytes / (1024 * 1024)).toFixed(2)} MB on disk)`,
  );
  console.log("By class:", byClass);
  console.log("Top 20:");
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  [${r.class}] ${r.file}`,
    );
  }

  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ${args.out}`);
  }
}

function statSyncSafe(p) {
  try {
    return readFileSync(p).byteLength;
  } catch {
    return 0;
  }
}

main();
