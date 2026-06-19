#!/usr/bin/env node

/**
 * css-coverage.mjs
 *
 * Parse CSS files, extract selectors, and check usage across the source tree.
 * Reports unused CSS selectors per file.
 *
 * Usage: node scripts/css-coverage.mjs [--json]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const ROOT = resolveRepoRootFromImportMeta(import.meta.url);

const CSS_FILES = [
  "packages/app-core/src/styles/styles.css",
  "packages/app-core/src/styles/base.css",
  "packages/app-core/src/styles/brand-gold.css",
  "packages/app-core/src/styles/electrobun-mac-window-drag.css",
  "packages/app-core/src/styles/xterm.css",
];

// Directories to search for selector usage
const SEARCH_DIRS = [
  "packages/app-core/src",
  "packages/ui/src",
  "packages/app/src",
  "packages/homepage/src",
];

/**
 * Extract CSS class selectors from a CSS file using regex.
 * Handles: .class-name, .class_name, .className, .class-name::pseudo
 * Skips: @import, @theme, @source, @keyframes names, CSS custom properties
 */
function extractSelectors(content) {
  const selectors = new Set();

  // Extract class selectors
  const classRe = /\.([a-zA-Z_][\w-]*)/g;
  for (;;) {
    const m = classRe.exec(content);
    if (!m) break;
    const cls = m[1];
    // Skip Tailwind directives, CSS functions, and very short generic names
    if (
      cls.startsWith("css") ||
      cls === "dark" ||
      cls === "light" ||
      cls.length < 2
    )
      continue;
    selectors.add(cls);
  }

  // Extract CSS custom properties (--var-name) defined in :root or selectors
  const varDefRe = /(--[\w-]+)\s*:/g;
  for (;;) {
    const m = varDefRe.exec(content);
    if (!m) break;
    selectors.add(m[1]);
  }

  // Extract @keyframes names
  const keyframesRe = /@keyframes\s+([\w-]+)/g;
  for (;;) {
    const m = keyframesRe.exec(content);
    if (!m) break;
    selectors.add(`@keyframes:${m[1]}`);
  }

  return [...selectors];
}

/**
 * Check if a selector is used anywhere in the source tree.
 * Uses ripgrep (rg) for speed, falls back to grep.
 */
function isUsed(selector, searchDirs) {
  // For CSS custom properties, search for var(--name) or the property name
  let searchTerm;
  if (selector.startsWith("--")) {
    searchTerm = selector;
  } else if (selector.startsWith("@keyframes:")) {
    searchTerm = selector.replace("@keyframes:", "");
  } else {
    searchTerm = selector;
  }

  // Search in TSX/TS/JSX/JS files for usage
  const dirs = searchDirs.map((d) => resolve(ROOT, d));
  try {
    execFileSync(
      "rg",
      [
        "-l",
        "--type-add",
        "src:*.{ts,tsx,js,jsx,css}",
        "-t",
        "src",
        "-F",
        searchTerm,
        ...dirs,
      ],
      { stdio: "pipe", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

// Process each CSS file
const report = {
  generated: new Date().toISOString(),
  files: [],
  summary: {
    totalSelectors: 0,
    usedSelectors: 0,
    unusedSelectors: 0,
    unusedByFile: {},
  },
};

for (const cssFile of CSS_FILES) {
  const fullPath = resolve(ROOT, cssFile);
  let content;
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    console.warn(`Skipping ${cssFile}: file not found`);
    continue;
  }

  const lines = content.split("\n").length;
  const selectors = extractSelectors(content);
  const fileReport = {
    file: cssFile,
    lines,
    totalSelectors: selectors.length,
    unused: [],
    used: [],
  };

  console.log(
    `Analyzing ${cssFile} (${lines} lines, ${selectors.length} selectors)...`,
  );

  // For large files, batch the checks
  for (const sel of selectors) {
    // Skip checking usage for CSS custom properties defined in theme files
    // They are used via var() in Tailwind and may not appear as direct string matches
    if (
      sel.startsWith("--") &&
      (cssFile.includes("base.css") ||
        cssFile.includes("theme.css") ||
        cssFile.includes("brand-gold.css"))
    ) {
      fileReport.used.push(sel);
      continue;
    }

    if (isUsed(sel, SEARCH_DIRS)) {
      fileReport.used.push(sel);
    } else {
      fileReport.unused.push(sel);
    }
  }

  report.files.push(fileReport);
  report.summary.totalSelectors += selectors.length;
  report.summary.usedSelectors += fileReport.used.length;
  report.summary.unusedSelectors += fileReport.unused.length;
  report.summary.unusedByFile[cssFile] = fileReport.unused.length;
}

// Check for duplicate selectors across files
const selectorToFiles = new Map();
for (const fileReport of report.files) {
  const allSelectors = [...fileReport.used, ...fileReport.unused];
  for (const sel of allSelectors) {
    if (!selectorToFiles.has(sel)) selectorToFiles.set(sel, []);
    selectorToFiles.get(sel).push(fileReport.file);
  }
}
report.duplicateSelectors = [...selectorToFiles.entries()]
  .filter(([, files]) => files.length > 1)
  .map(([selector, files]) => ({ selector, files }));

const jsonFlag = process.argv.includes("--json");
if (jsonFlag) {
  writeFileSync(
    resolve(ROOT, "css-coverage-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("\nWritten to css-coverage-report.json");
} else {
  console.log("\n=== CSS COVERAGE REPORT ===\n");

  for (const fileReport of report.files) {
    const pct = fileReport.totalSelectors
      ? Math.round((fileReport.used.length / fileReport.totalSelectors) * 100)
      : 100;
    console.log(
      `${fileReport.file}: ${fileReport.lines} lines, ${fileReport.totalSelectors} selectors, ${pct}% used`,
    );
    if (fileReport.unused.length > 0) {
      console.log(`  Unused (${fileReport.unused.length}):`);
      for (const sel of fileReport.unused.slice(0, 20)) {
        console.log(`    .${sel}`);
      }
      if (fileReport.unused.length > 20) {
        console.log(`    ... and ${fileReport.unused.length - 20} more`);
      }
    }
  }

  console.log(
    "\n=== DUPLICATE SELECTORS (defined in multiple CSS files) ===\n",
  );
  const dupes = report.duplicateSelectors.filter(
    (d) => !d.selector.startsWith("--"),
  );
  for (const d of dupes.slice(0, 30)) {
    console.log(`  .${d.selector}: ${d.files.join(", ")}`);
  }
  if (dupes.length > 30) {
    console.log(`  ... and ${dupes.length - 30} more`);
  }

  console.log(
    `\nSummary: ${report.summary.totalSelectors} total selectors, ${report.summary.usedSelectors} used, ${report.summary.unusedSelectors} potentially unused`,
  );
  console.log(
    `Duplicate selectors across files: ${report.duplicateSelectors.length}`,
  );
}
