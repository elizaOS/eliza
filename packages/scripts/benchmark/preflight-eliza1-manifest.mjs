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

export const HF_REPO = "elizaos/eliza-1";
const HF_BASE = (process.env.ELIZA_HF_BASE_URL || "https://huggingface.co").replace(/\/+$/, "");

// tier id -> published bundle slug (mirrors catalog `ELIZA_1_PUBLISHED_SLUGS`).
//
// The published `elizaos/eliza-1` tree was re-slugged during the 2026-06→07
// Gemma-4 cutover: bundles are now hosted under ARCHITECTURE slugs
// (`e2b`/`e4b`/`12b`/`31b`/`31b-256k`), not the removed size slugs
// (`2b`/`4b`/`9b`/`27b`/`27b-256k`). This must match
// packages/shared/src/local-inference/catalog.ts::ELIZA_1_PUBLISHED_SLUGS or the
// preflight validates a 404 path while the runtime downloads a different one
// (issue #15976). The parity is pinned by
// packages/scripts/__tests__/preflight-eliza1-manifest.test.ts.
export const TIER_SLUG = {
  "eliza-1-2b": "e2b",
  "eliza-1-4b": "e4b",
  "eliza-1-9b": "12b",
  "eliza-1-27b": "31b",
  "eliza-1-27b-256k": "31b-256k",
};

// Buckets the runtime schema requires to be a NON-EMPTY array.
const REQUIRED_ARRAY = ["text", "voice", "cache"];
// Buckets the runtime schema requires to be an array (may be empty).
const ARRAY_KINDS = ["asr", "vision", "mtp"];

export function manifestUrl(tierId) {
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

// Only run the CLI when invoked directly (so tests can import TIER_SLUG /
// manifestUrl without triggering a network fetch + process.exit).
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((err) => {
    process.stderr.write(`[preflight-manifest] FATAL: ${err?.stack || err}\n`);
    process.exit(2);
  });
}
