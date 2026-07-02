#!/usr/bin/env node
// Loud preflight for the Local Inference Bench nightly lane.
//
// The nightly job boots `bun run dev`, then `profile-inference.mjs --ensure-models`
// asks the running agent to download the bench models. The agent fetches the
// PUBLISHED HuggingFace bundle manifest and validates it against the Eliza-1
// manifest schema before touching any weight byte. When a published manifest is
// malformed (e.g. `files.vision` emitted as an object instead of an array, as
// happened during the 2026-06→07 Gemma-4 cutover), the download fails with a
// mid-run stack trace ~5 minutes into the run — AFTER a full `bun install` +
// agent boot. That is a confusing, expensive red for what is really a
// bad-published-artifact problem the CI runner cannot fix.
//
// This preflight fetches the published manifest(s) for the bench tiers and
// asserts the shape the runtime schema requires (packages/shared manifest
// schema: every `files.<kind>` bucket is an ARRAY). It runs in seconds, before
// the install/boot, and fails LOUDLY with an operator-actionable message so the
// lane stops burning minutes on an unfixable artifact defect.
//
// Usage:
//   node packages/scripts/benchmark/preflight-eliza1-manifest.mjs eliza-1-2b [eliza-1-4b ...]
//
// Exit codes: 0 = manifest(s) valid; 2 = malformed/unreachable manifest.

const HF_REPO = "elizaos/eliza-1";
const HF_BASE = (process.env.ELIZA_HF_BASE_URL || "https://huggingface.co").replace(/\/+$/, "");

// tier id -> published bundle prefix (mirrors catalog `bundleRemotePrefix`)
const TIER_SLUG = {
  "eliza-1-2b": "2b",
  "eliza-1-4b": "4b",
  "eliza-1-9b": "9b",
  "eliza-1-27b": "27b",
  "eliza-1-27b-256k": "27b-256k",
};

// Buckets the runtime schema requires to be a NON-EMPTY array.
const REQUIRED_ARRAY = ["text", "voice", "cache"];
// Buckets the runtime schema requires to be an array (may be empty).
const ARRAY_KINDS = ["asr", "vision", "mtp"];

function manifestUrl(tierId) {
  const slug = TIER_SLUG[tierId];
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

function validateShape(tierId, manifest) {
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
      problems.push(`files.${kind}: required non-empty array, received empty array`);
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
      const problems = validateShape(tierId, manifest);
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
      failed = true;
      process.stderr.write(`\n[preflight-manifest] ✗ ${tierId}: ${err.message}\n`);
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

main().catch((err) => {
  process.stderr.write(`[preflight-manifest] FATAL: ${err?.stack || err}\n`);
  process.exit(2);
});
