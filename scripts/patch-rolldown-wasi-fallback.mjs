#!/usr/bin/env node
/**
 * Rolldown's native optional dependency can fail macOS code-signature
 * validation under newer Node runtimes. Rolldown also ships a WASI binding,
 * but the generated loader throws before reaching it when every native
 * candidate fails. Patch installed Rolldown loaders to fall back to WASI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const NEEDLE = `\tnativeBinding = requireNative();\n\tif (!nativeBinding || process.env.NAPI_RS_FORCE_WASI) {`;
const REPLACEMENT =
  `\tif (!process.env.NAPI_RS_FORCE_WASI) {\n` +
  `\t\ttry {\n` +
  `\t\t\tnativeBinding = requireNative();\n` +
  `\t\t} catch (err) {\n` +
  `\t\t\tloadErrors.push(err);\n` +
  `\t\t}\n` +
  `\t}\n` +
  `\tif (!nativeBinding || process.env.NAPI_RS_FORCE_WASI) {`;

function collectRolldownBindingFiles() {
  const out = [];
  const bunRoots = [
    join(repoRoot, "node_modules", ".bun"),
    join(repoRoot, "cloud", "node_modules", ".bun"),
  ];

  for (const bunRoot of bunRoots) {
    if (!existsSync(bunRoot)) continue;
    for (const entry of readdirSync(bunRoot)) {
      if (!entry.startsWith("rolldown@")) continue;
      const sharedDir = join(
        bunRoot,
        entry,
        "node_modules",
        "rolldown",
        "dist",
        "shared",
      );
      if (!existsSync(sharedDir)) continue;
      for (const file of readdirSync(sharedDir)) {
        if (file.startsWith("binding-") && file.endsWith(".mjs")) {
          out.push(join(sharedDir, file));
        }
      }
    }
  }

  return out;
}

function walkFiles(root, predicate, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function collectDarwinNativeBindings() {
  if (process.platform !== "darwin") return [];

  const out = [];
  const bunRoots = [
    join(repoRoot, "node_modules", ".bun"),
    join(repoRoot, "cloud", "node_modules", ".bun"),
  ];

  for (const bunRoot of bunRoots) {
    if (!existsSync(bunRoot)) continue;
    for (const entry of readdirSync(bunRoot)) {
      if (!entry.startsWith("@rolldown+binding-darwin-")) continue;
      walkFiles(
        join(bunRoot, entry),
        (filePath) => filePath.endsWith(".node"),
        out,
      );
    }
  }

  return out;
}

let patched = 0;
for (const filePath of collectRolldownBindingFiles()) {
  const source = readFileSync(filePath, "utf8");
  if (!source.includes(NEEDLE)) continue;
  writeFileSync(filePath, source.replace(NEEDLE, REPLACEMENT), "utf8");
  console.log(`[patch-rolldown-wasi-fallback] Patched ${filePath}`);
  patched++;
}

let signed = 0;
for (const filePath of collectDarwinNativeBindings()) {
  const result = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    signed++;
  } else if (process.env.VERBOSE) {
    console.warn(
      `[patch-rolldown-wasi-fallback] Failed to sign ${filePath}: ${
        result.stderr || result.error?.message || "unknown error"
      }`,
    );
  }
}

if (signed > 0) {
  console.log(
    `[patch-rolldown-wasi-fallback] Ad-hoc signed ${signed} macOS Rolldown binding(s).`,
  );
}

if (patched === 0 && process.env.VERBOSE) {
  console.log(
    "[patch-rolldown-wasi-fallback] No unpatched Rolldown loaders found.",
  );
}
