#!/usr/bin/env node
/**
 * Validates the manifest shape for explicitly published Eliza-1 tiers before
 * the nightly benchmark spends time installing dependencies and booting an
 * agent. The tier map mirrors the runtime catalog and excludes pending tiers.
 */

import { pathToFileURL } from "node:url";

export const HF_REPO = "elizaos/eliza-1";
export const TIER_SLUG = Object.freeze({
  "eliza-1-2b": "e2b",
  "eliza-1-4b": "e4b",
});

const REQUIRED_ARRAY = ["text", "voice", "cache"];
const ARRAY_KINDS = ["asr", "vision", "mtp"];

export function manifestUrl(
  tierId,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone preflight is intentionally configurable outside Turbo tasks.
  baseUrl = process.env.ELIZA_HF_BASE_URL || "https://huggingface.co",
) {
  const slug = TIER_SLUG[tierId];
  if (!slug) {
    throw new Error(
      `tier ${tierId} is not published; available tiers: ${Object.keys(TIER_SLUG).join(", ")}`,
    );
  }
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${HF_REPO}/resolve/main/bundles/${slug}/eliza-1.manifest.json?download=true`;
}

export function validateShape(manifest) {
  const problems = [];
  const files = manifest?.files;
  if (files == null || typeof files !== "object" || Array.isArray(files)) {
    return ["`files` is missing or not an object"];
  }
  for (const kind of [...REQUIRED_ARRAY, ...ARRAY_KINDS]) {
    const value = files[kind];
    if (!Array.isArray(value)) {
      problems.push(
        `files.${kind}: expected array, received ${value === undefined ? "undefined" : typeof value}`,
      );
    } else if (REQUIRED_ARRAY.includes(kind) && value.length === 0) {
      problems.push(
        `files.${kind}: required non-empty array, received empty array`,
      );
    }
  }
  return problems;
}

export async function runPreflight(
  tiers,
  {
    fetchImpl = fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    baseUrl,
  } = {},
) {
  if (tiers.length === 0) {
    stderr.write("[preflight-manifest] no tier ids supplied\n");
    return 2;
  }

  let failed = false;
  for (const tierId of tiers) {
    try {
      const url = manifestUrl(tierId, baseUrl);
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} fetching ${url}`,
        );
      }
      const manifest = await response.json();
      const problems = validateShape(manifest);
      if (problems.length === 0) {
        stdout.write(
          `[preflight-manifest] ✓ ${tierId} published manifest shape OK\n`,
        );
        continue;
      }
      failed = true;
      stderr.write(
        `\n[preflight-manifest] ✗ ${tierId} published manifest is MALFORMED:\n`,
      );
      for (const problem of problems) stderr.write(`    - ${problem}\n`);
      stderr.write(`    manifest: ${url}\n`);
    } catch (error) {
      failed = true;
      stderr.write(
        `\n[preflight-manifest] ✗ ${tierId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (failed) {
    stderr.write(
      "\n[preflight-manifest] The nightly bench consumes the published Hugging Face\n" +
        "  manifest before downloading weights. Repair the published tier mapping or\n" +
        "  artifact contract before retrying; pending tiers must remain unavailable.\n",
    );
    return 2;
  }
  return 0;
}

async function main() {
  process.exitCode = await runPreflight(process.argv.slice(2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `[preflight-manifest] FATAL: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
