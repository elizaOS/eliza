#!/usr/bin/env node
/**
 * One-shot migration script: extracts keyword data from the hand-written
 * validation-keywords.ts files and emits clean JSON.
 *
 * Usage:
 *   node scripts/extract-keywords-to-json.mjs
 *
 * Reads the compiled .js files (which already exist alongside the .ts),
 * walks the VALIDATION_KEYWORD_DOCS tree, and writes JSON to:
 *   src/i18n/keywords/shared.keywords.json
 *
 * Also extracts from @elizaos/typescript if available.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedI18nDir = join(__dirname, "..", "src", "i18n");
const keywordsDir = join(sharedI18nDir, "keywords");

mkdirSync(keywordsDir, { recursive: true });

/**
 * Parse the multiline termDoc strings into arrays of terms.
 */
function splitTermDoc(value) {
  if (!value || typeof value !== "string") return [];
  const seen = new Set();
  const terms = [];
  for (const line of value.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = trimmed.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(trimmed);
  }
  return terms;
}

/**
 * Check if a value is a keyword doc (leaf node with base/locales).
 */
function isKeywordDoc(value) {
  if (!value || typeof value !== "object") return false;
  return "base" in value || "locales" in value;
}

/**
 * Recursively walk the keyword tree and collect entries as dotted-key -> { base, locales }.
 */
function collectEntries(tree, prefix = "") {
  const entries = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isKeywordDoc(value)) {
      const entry = {};
      if (value.base) {
        entry.base = splitTermDoc(value.base);
      }
      if (value.locales) {
        for (const [locale, localeValue] of Object.entries(value.locales)) {
          const terms = splitTermDoc(localeValue);
          if (terms.length > 0) {
            entry[locale] = terms;
          }
        }
      }
      entries[path] = entry;
    } else if (value && typeof value === "object") {
      Object.assign(entries, collectEntries(value, path));
    }
  }
  return entries;
}

// --- Extract from shared package ---

// We need to parse the TS source directly since we can't import it easily.
// The structure is: const VALIDATION_KEYWORD_DOCS = { ... } as const satisfies ...
// We'll use a regex-based approach to extract the object, or eval the .js file.

async function extractFromFile(tsPath, label) {
  // Try the compiled .js first
  const jsPath = tsPath.replace(/\.ts$/, ".js");
  let jsContent;
  try {
    jsContent = readFileSync(jsPath, "utf-8");
  } catch {
    console.error(`  No compiled .js found at ${jsPath}, trying .ts parse...`);
    return null;
  }

  // The .js file exports functions. We need the VALIDATION_KEYWORD_DOCS constant.
  // It's not exported directly, but we can extract it by evaluating the module
  // and calling the exported functions... or we can parse the TS source.

  // Actually, let's parse the .ts source directly - it's more reliable.
  const tsContent = readFileSync(tsPath, "utf-8");

  // Extract the VALIDATION_KEYWORD_DOCS object by finding it in the source
  const startMarker = "const VALIDATION_KEYWORD_DOCS = {";
  const startIdx = tsContent.indexOf(startMarker);
  if (startIdx === -1) {
    console.error(`  Could not find VALIDATION_KEYWORD_DOCS in ${tsPath}`);
    return null;
  }

  // Find the matching closing brace + "as const satisfies"
  let depth = 0;
  let endIdx = startIdx + startMarker.length - 1; // position of first {
  for (let i = endIdx; i < tsContent.length; i++) {
    if (tsContent[i] === "{") depth++;
    else if (tsContent[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  let objSource = tsContent.slice(startIdx, endIdx);
  // Remove the const declaration to get just the object
  objSource = objSource.replace(/^const VALIDATION_KEYWORD_DOCS\s*=\s*/, "");

  // Replace termDoc(`...`) calls with the raw string content
  // termDoc just trims, so we can replace with the template literal content
  objSource = objSource.replace(/termDoc\(`([^`]*)`\)/g, (_, content) => {
    return JSON.stringify(content.trim());
  });

  // Remove TypeScript type annotations
  objSource = objSource.replace(/as\s+const\s+satisfies\s+\w+/g, "");

  // Evaluate the cleaned object
  let docs;
  try {
    docs = eval(`(${objSource})`);
  } catch (e) {
    console.error(`  Failed to eval extracted object from ${tsPath}:`, e.message);
    // Try to write it out for debugging
    writeFileSync(join(keywordsDir, `_debug_${label}.js`), `(${objSource})`, "utf-8");
    return null;
  }

  console.log(`  Extracted ${label}: ${Object.keys(docs).length} top-level keys`);
  return collectEntries(docs);
}

console.log("Extracting keyword data from validation-keywords.ts files...\n");

// Extract from shared
const sharedPath = join(sharedI18nDir, "validation-keywords.ts");
console.log(`Processing: shared (${sharedPath})`);
const sharedEntries = await extractFromFile(sharedPath, "shared");

if (sharedEntries) {
  // Collect all locales used
  const locales = new Set();
  for (const entry of Object.values(sharedEntries)) {
    for (const key of Object.keys(entry)) {
      if (key !== "base") locales.add(key);
    }
  }

  const json = {
    $schema: "./keywords.schema.json",
    locales: [...locales].sort(),
    entries: sharedEntries,
  };

  const outPath = join(keywordsDir, "shared.keywords.json");
  writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log(`  Wrote ${outPath} (${Object.keys(sharedEntries).length} entries)\n`);
}

// Extract from typescript package
const tsPackagePath = join(
  __dirname, "..", "..", "typescript", "src", "i18n", "validation-keywords.ts"
);
console.log(`Processing: typescript (${tsPackagePath})`);
const tsEntries = await extractFromFile(tsPackagePath, "typescript");

if (tsEntries) {
  const locales = new Set();
  for (const entry of Object.values(tsEntries)) {
    for (const key of Object.keys(entry)) {
      if (key !== "base") locales.add(key);
    }
  }

  const json = {
    $schema: "./keywords.schema.json",
    locales: [...locales].sort(),
    entries: tsEntries,
  };

  const outPath = join(keywordsDir, "typescript.keywords.json");
  writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log(`  Wrote ${outPath} (${Object.keys(tsEntries).length} entries)\n`);
}

console.log("Done! Review the JSON files in src/i18n/keywords/");
