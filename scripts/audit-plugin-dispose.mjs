#!/usr/bin/env node
/**
 * Plugin dispose hook auditor.
 *
 * Scans plugins/ and packages/ for Plugin objects, checks whether they declare
 * a dispose hook, and flags HIGH RISK plugins that have services (which require
 * cleanup) but no dispose hook.
 *
 * Output formats:
 *   --json    Machine-readable JSON
 *   (default) Human-readable Markdown-style text
 *
 * Run:
 *   node scripts/audit-plugin-dispose.mjs
 *   node scripts/audit-plugin-dispose.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const JSON_MODE = process.argv.includes("--json");

const SCAN_ROOTS = [
  path.join(REPO_ROOT, "plugins"),
  path.join(REPO_ROOT, "packages"),
];

const SKIP_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "__tests__",
  "test",
  "tests",
  "fixtures",
  "generated",
  "scripts",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);
const MAX_FILE_BYTES = 500_000;

/** @returns {string[]} */
function walk(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name))
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Very lightweight heuristic text scan.
 *
 * We look for files that look like they export a plugin object (have both
 * `name:` and `description:` as plugin object fields) and check for:
 *   - presence of `dispose` (property or method)
 *   - presence of `services` (indicates cleanup risk)
 *
 * This is intentionally heuristic — no AST parsing — so it may have false
 * positives. The goal is to surface patterns that need human review.
 *
 * @param {string} filePath
 * @returns {{ hasPlugin: boolean; hasDispose: boolean; hasServices: boolean; pluginNames: string[] } | null}
 */
function scanFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) return null;

  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  // Quick bail: must look like it involves a Plugin object
  // Heuristic: file exports something shaped like a plugin
  const looksLikePlugin =
    /\bname\s*:\s*["'`]/.test(src) &&
    /\bdescription\s*:\s*["'`]/.test(src) &&
    (/\bPlugin\b/.test(src) || /\bactions\s*:/.test(src) || /\bproviders\s*:/.test(src));

  if (!looksLikePlugin) return null;

  const hasDispose = /\bdispose\s*[:(]/.test(src) || /\bdispose\s*=/.test(src);
  const hasServices =
    /\bservices\s*:/.test(src) || /registerSendHandler/.test(src);

  // Extract plugin name candidates from `name: "some-name"` patterns
  const pluginNames = [];
  for (const match of src.matchAll(/\bname\s*:\s*["'`]([^"'`\n]{1,80})["'`]/g)) {
    const name = match[1].trim();
    // Skip obvious non-plugin names (generic labels like "name" etc.)
    if (name && name.length > 2 && (name.includes("-") || name.includes("/"))) {
      pluginNames.push(name);
    }
  }

  return {
    hasPlugin: true,
    hasDispose,
    hasServices,
    pluginNames,
  };
}

/** @returns {string} */
function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath);
}

function run() {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));

  const results = {
    withDispose: [],
    withoutDispose: [],
    highRisk: [], // has services but no dispose
  };

  for (const filePath of files) {
    const info = scanFile(filePath);
    if (!info) continue;

    const entry = {
      file: relPath(filePath),
      pluginNames: info.pluginNames,
      hasServices: info.hasServices,
    };

    if (info.hasDispose) {
      results.withDispose.push(entry);
    } else {
      results.withoutDispose.push(entry);
      if (info.hasServices) {
        results.highRisk.push(entry);
      }
    }
  }

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify(
        {
          summary: {
            withDispose: results.withDispose.length,
            withoutDispose: results.withoutDispose.length,
            highRisk: results.highRisk.length,
          },
          withDispose: results.withDispose,
          withoutDispose: results.withoutDispose,
          highRisk: results.highRisk,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
    return;
  }

  // Human-readable output
  console.log("# Plugin dispose hook audit\n");
  console.log(`Scanned ${files.length} source files.\n`);
  console.log(
    `## Summary\n- Has dispose hook: ${results.withDispose.length}\n- Missing dispose hook: ${results.withoutDispose.length}\n- HIGH RISK (services, no dispose): ${results.highRisk.length}\n`,
  );

  if (results.highRisk.length > 0) {
    console.log("## HIGH RISK — has services but no dispose hook\n");
    for (const entry of results.highRisk) {
      const names =
        entry.pluginNames.length > 0
          ? ` (${entry.pluginNames.slice(0, 2).join(", ")})`
          : "";
      console.log(`  - ${entry.file}${names}`);
    }
    console.log();
  }

  if (results.withoutDispose.length > 0) {
    console.log("## Missing dispose hook\n");
    for (const entry of results.withoutDispose) {
      const names =
        entry.pluginNames.length > 0
          ? ` (${entry.pluginNames.slice(0, 2).join(", ")})`
          : "";
      const risk = entry.hasServices ? " [HAS SERVICES]" : "";
      console.log(`  - ${entry.file}${names}${risk}`);
    }
    console.log();
  }

  if (results.withDispose.length > 0) {
    console.log("## Has dispose hook\n");
    for (const entry of results.withDispose) {
      const names =
        entry.pluginNames.length > 0
          ? ` (${entry.pluginNames.slice(0, 2).join(", ")})`
          : "";
      console.log(`  - ${entry.file}${names}`);
    }
    console.log();
  }
}

run();
