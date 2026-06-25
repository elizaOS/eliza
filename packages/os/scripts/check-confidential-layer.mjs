#!/usr/bin/env node
// OS-1 gate: confidential-layer-check (plan §1.3 / OS-1).
//
// Lightweight validator for the meta-elizaos Yocto layer. It does NOT run
// bitbake (the full image build is BLOCKED on a build host); it asserts the two
// things that can drift without a build host and that would make the layer
// silently broken or larp:
//
//   1. conf/layer.conf declares the required OE collection directives with the
//      collection name "meta-elizaos" (BBFILE_COLLECTIONS, BBFILE_PATTERN_*,
//      BBFILE_PRIORITY_*, LAYERSERIES_COMPAT_*, LAYERDEPENDS_*), and BBFILES is
//      set. A layer missing these is not parseable by bitbake.
//   2. every `file://` SRC_URI entry in every shipped .bb recipe resolves to a
//      file that actually exists in-tree (relative to the recipe's
//      FILESEXTRAPATHS / the confidential dir). A recipe that references a
//      nonexistent install source is larp and fails closed here.
//
// Runner: plain `node` (no third-party deps). node --test for the tests.
//   node packages/os/scripts/check-confidential-layer.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileExists, repoRoot } from "./os-release-lib.mjs";

const LAYER_DIR = path.join(
  repoRoot,
  "packages/os/linux/confidential/meta-elizaos",
);
const CONFIDENTIAL_DIR = path.join(repoRoot, "packages/os/linux/confidential");
const LAYER_CONF = path.join(LAYER_DIR, "conf/layer.conf");

const REQUIRED_DIRECTIVES = [
  // directive (regex source), human label
  ["BBFILES\\s*[+:]?=", "BBFILES"],
  [
    "BBFILE_COLLECTIONS\\s*[+:]?=.*meta-elizaos",
    "BBFILE_COLLECTIONS meta-elizaos",
  ],
  ["BBFILE_PATTERN_meta-elizaos\\s*=", "BBFILE_PATTERN_meta-elizaos"],
  ["BBFILE_PRIORITY_meta-elizaos\\s*=", "BBFILE_PRIORITY_meta-elizaos"],
  ["LAYERSERIES_COMPAT_meta-elizaos\\s*=", "LAYERSERIES_COMPAT_meta-elizaos"],
  ["LAYERDEPENDS_meta-elizaos\\s*=", "LAYERDEPENDS_meta-elizaos"],
];

// Recursively collect every *.bb file under the layer.
async function findRecipes(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findRecipes(full)));
    } else if (entry.name.endsWith(".bb")) {
      out.push(full);
    }
  }
  return out;
}

// Extract every concrete file:// source path from a recipe's SRC_URI
// assignment. Bitbake SRC_URI may span multiple lines via trailing backslash, so
// we isolate the SRC_URI block (from `SRC_URI ... = "` to the closing quote) and
// scan only inside it. Paths containing a ${...} bitbake variable (e.g. license
// references like ${COMMON_LICENSE_DIR}) are build-host-resolved and skipped —
// only literal in-tree sources are checked for existence.
function extractFileUris(recipeText) {
  const block = recipeText.match(/SRC_URI\s*[+:]?=\s*"([\s\S]*?)"/);
  if (!block) return [];
  // Only literal in-tree sources; ${...} bitbake variables are skipped.
  return [...block[1].matchAll(/file:\/\/([^\s"\\;]+)/g)]
    .map((m) => m[1])
    .filter((candidate) => !candidate.includes("${"));
}

export function checkLayerConf(confText) {
  const errors = [];
  for (const [pattern, label] of REQUIRED_DIRECTIVES) {
    if (!new RegExp(pattern).test(confText)) {
      errors.push(`conf/layer.conf is missing required directive: ${label}`);
    }
  }
  return errors;
}

// Resolve a recipe's file:// source against the FILESEXTRAPATHS used by the
// recipe. Our recipe prepends "${THISDIR}/../../../" → the confidential dir, so
// file:// paths are relative to packages/os/linux/confidential/.
async function checkRecipeSources(recipePath, recipeText) {
  const errors = [];
  for (const uri of extractFileUris(recipeText)) {
    const resolved = path.join(CONFIDENTIAL_DIR, uri);
    if (!(await fileExists(resolved))) {
      errors.push(
        `${path.relative(repoRoot, recipePath)} references missing source file://${uri} ` +
          `(expected at ${path.relative(repoRoot, resolved)})`,
      );
    }
  }
  return errors;
}

export async function checkConfidentialLayer() {
  const errors = [];

  if (!(await fileExists(LAYER_CONF))) {
    return { ok: false, errors: ["conf/layer.conf is missing"] };
  }
  const confText = await readFile(LAYER_CONF, "utf8");
  errors.push(...checkLayerConf(confText));

  const recipes = await findRecipes(path.join(LAYER_DIR, "recipes-elizaos"));
  if (recipes.length === 0) {
    errors.push("no .bb recipe found under recipes-elizaos/");
  }
  for (const recipe of recipes) {
    const text = await readFile(recipe, "utf8");
    errors.push(...(await checkRecipeSources(recipe, text)));
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const result = await checkConfidentialLayer();
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("confidential-layer-check: FAIL-CLOSED");
    process.exit(1);
  }
  console.log(
    `confidential-layer-check: PASS (${path.relative(repoRoot, LAYER_DIR)})`,
  );
}

export { extractFileUris, LAYER_DIR };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
