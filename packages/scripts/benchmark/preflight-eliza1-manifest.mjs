#!/usr/bin/env node
/**
 * Validates published Eliza-1 bundle manifests before the nightly inference
 * lane pays the cost of dependency installation and agent boot. Stable runtime
 * model ids map explicitly to the architecture-oriented Hugging Face layout so
 * this boundary checks the same artifacts that the downloader will consume.
 */

import { pathToFileURL } from "node:url";

const HF_REPO = "elizaos/eliza-1";
const HF_BASE = (
  process.env.ELIZA_HF_BASE_URL || "https://huggingface.co"
).replace(/\/+$/, "");

export const PUBLISHED_TIER_SLUG = {
  "eliza-1-2b": "e2b",
  "eliza-1-4b": "e4b",
  "eliza-1-9b": "12b",
  "eliza-1-27b": "31b",
  "eliza-1-27b-256k": "31b-256k",
};

const REQUIRED_ARRAY = ["text", "voice", "cache"];
const ARRAY_KINDS = ["asr", "vision", "mtp"];

export function manifestUrl(tierId) {
  const slug = PUBLISHED_TIER_SLUG[tierId];
  if (!slug) throw new Error(`unknown tier id: ${tierId}`);
  return `${HF_BASE}/${HF_REPO}/resolve/main/bundles/${slug}/eliza-1.manifest.json?download=true`;
}

async function fetchManifest(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  return res.json();
}

export function validateShape(manifest) {
  const problems = [];
  const files = manifest?.files;
  if (files == null || typeof files !== "object" || Array.isArray(files)) {
    problems.push("`files` is missing or not an object");
    return problems;
  }
  for (const kind of [...REQUIRED_ARRAY, ...ARRAY_KINDS]) {
    const v = files[kind];
    if (!Array.isArray(v)) {
      problems.push(
        `files.${kind}: expected array, received ${v === undefined ? "undefined" : Array.isArray(v) ? "array" : typeof v}`,
      );
      continue;
    }
    if (REQUIRED_ARRAY.includes(kind) && v.length === 0) {
      problems.push(
        `files.${kind}: required non-empty array, received empty array`,
      );
    }
  }
  return problems;
}

async function main() {
  const tiers = process.argv.slice(2);
  if (tiers.length === 0) {
    process.stderr.write("[preflight-manifest] no tier ids supplied\n");
    process.exit(2);
  }
  let failed = false;
  for (const tierId of tiers) {
    const url = manifestUrl(tierId);
    try {
      const manifest = await fetchManifest(url);
      const problems = validateShape(manifest);
      if (problems.length > 0) {
        failed = true;
        process.stderr.write(
          `\n[preflight-manifest] ✗ ${tierId} published manifest is MALFORMED:\n`,
        );
        for (const p of problems) process.stderr.write(`    - ${p}\n`);
        process.stderr.write(`    manifest: ${url}\n`);
      } else {
        process.stdout.write(
          `[preflight-manifest] ✓ ${tierId} published manifest shape OK\n`,
        );
      }
    } catch (err) {
      // error-policy:J1 Report each requested tier at the CLI boundary.
      failed = true;
      process.stderr.write(
        `\n[preflight-manifest] ✗ ${tierId}: ${err.message}\n`,
      );
    }
  }
  if (failed) {
    process.stderr.write(
      "\n[preflight-manifest] The nightly bench downloads the PUBLISHED HuggingFace\n" +
        "  bundle manifest and validates it against the Eliza-1 manifest schema before\n" +
        "  fetching weights. The manifest above does not match the schema, so booting\n" +
        "  the agent and running the harness would fail ~5 minutes in with an opaque\n" +
        "  'expected array, received object' stack trace.\n\n" +
        "  This is a PUBLISHED-ARTIFACT defect, not a code or runner problem. Fix it by\n" +
        "  regenerating the bundle manifest with packages/training/scripts/manifest/ and\n" +
        `  re-publishing to https://huggingface.co/${HF_REPO} (needs HF write access).\n`,
    );
    process.exit(2);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    // error-policy:J1 Translate an unexpected CLI failure into the documented exit code.
    process.stderr.write(`[preflight-manifest] FATAL: ${err?.stack || err}\n`);
    process.exit(2);
  });
}
