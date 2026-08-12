#!/usr/bin/env node
/**
 * Validates that published release assets are reachable on the CDN: reads the
 * static asset manifest, builds asset URLs for the resolved release tag, and
 * probes them with a retry/concurrency policy tuned for CI flakiness.
 *
 * Retry-policy env overrides must be complete safe-integer decimals. Partial
 * `Number.parseInt` accepts (`1junk` → 1) previously applied a different
 * attempts/delay/concurrency budget than the operator requested.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildReleaseValidationAssetUrl,
  resolveElizaAssetRepository,
  resolveElizaReleaseTag,
} from "./lib/asset-cdn.mjs";
import {
  readStaticAssetManifest,
  validateStaticAssetManifest,
} from "./lib/static-asset-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const CI_RETRYABLE_STATUSES = new Set([0, 429, 500, 502, 503, 504]);

/** Local defaults when CI is not set. */
export const DEFAULT_LOCAL_RETRY_POLICY = Object.freeze({
  attempts: 1,
  delayMs: 0,
  concurrency: 2,
});

/** CI defaults: more retries and parallel probes for flaky CDN edges. */
export const DEFAULT_CI_RETRY_POLICY = Object.freeze({
  attempts: 3,
  delayMs: 5000,
  concurrency: 4,
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnsetEnv(value) {
  return value === undefined || String(value).trim() === "";
}

/**
 * Accept only complete positive safe-integer decimal strings (or numbers).
 * Rejects partial numbers, signed values, fractions, leading zeros, and
 * non-positive values so a typo cannot silently become a 1-attempt policy.
 * @param {string | number} value
 * @param {string} label
 * @returns {number}
 */
export function parsePositiveSafeInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `${label} must be a positive safe-integer decimal (received ${JSON.stringify(value)})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return parsed;
}

/**
 * Accept only complete non-negative safe-integer decimal strings (or numbers),
 * including zero. Same reject set as {@link parsePositiveSafeInteger} except 0.
 * @param {string | number} value
 * @param {string} label
 * @returns {number}
 */
export function parseNonNegativeSafeInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `${label} must be a non-negative safe-integer decimal (received ${JSON.stringify(value)})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a non-negative safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
    throw new Error(
      `${label} must be a non-negative safe-integer decimal (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return parsed;
}

/**
 * Resolve CDN validation retry policy from env. Unset/empty overrides keep the
 * current CI or local defaults; any other explicit value must be a complete
 * safe-integer decimal or the command fails closed before probes.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ attempts: number, delayMs: number, concurrency: number }}
 */
export function getValidationRetryPolicy({ env = process.env } = {}) {
  const inCi = String(env.CI ?? "").toLowerCase() === "true";
  const defaults = inCi ? DEFAULT_CI_RETRY_POLICY : DEFAULT_LOCAL_RETRY_POLICY;

  const attempts = isUnsetEnv(env.ELIZA_CDN_VALIDATE_ATTEMPTS)
    ? defaults.attempts
    : parsePositiveSafeInteger(
        String(env.ELIZA_CDN_VALIDATE_ATTEMPTS).trim(),
        "ELIZA_CDN_VALIDATE_ATTEMPTS",
      );
  const delayMs = isUnsetEnv(env.ELIZA_CDN_VALIDATE_DELAY_MS)
    ? defaults.delayMs
    : parseNonNegativeSafeInteger(
        String(env.ELIZA_CDN_VALIDATE_DELAY_MS).trim(),
        "ELIZA_CDN_VALIDATE_DELAY_MS",
      );
  const concurrency = isUnsetEnv(env.ELIZA_CDN_VALIDATE_CONCURRENCY)
    ? defaults.concurrency
    : parsePositiveSafeInteger(
        String(env.ELIZA_CDN_VALIDATE_CONCURRENCY).trim(),
        "ELIZA_CDN_VALIDATE_CONCURRENCY",
      );

  return { attempts, delayMs, concurrency };
}

async function headManagedAssetUrl(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return {
      ok: response.ok,
      status: response.status,
      url,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      url,
    };
  }
}

async function probeManagedAssetUrl(url, retryPolicy) {
  let result = await headManagedAssetUrl(url);
  if (result.ok) {
    return result;
  }

  const isRetryable =
    CI_RETRYABLE_STATUSES.has(result.status) && retryPolicy.attempts > 1;
  if (!isRetryable) {
    return result;
  }

  for (let attempt = 2; attempt <= retryPolicy.attempts; attempt += 1) {
    if (retryPolicy.delayMs > 0) {
      await delay(retryPolicy.delayMs);
    }
    result = await headManagedAssetUrl(url);
    if (result.ok) {
      return result;
    }
  }

  return result;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function validateGroup(
  files,
  { repository, releaseTag, assetRoot, retryPolicy },
) {
  let pending = files.map((file) => {
    const suffix = file.split("/").slice(3).join("/");
    return buildReleaseValidationAssetUrl({
      repository,
      releaseTag,
      assetRoot,
      assetPath: suffix,
    });
  });
  let lastMissing = [];

  for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
    const responses = await mapWithConcurrency(
      pending,
      retryPolicy.concurrency,
      async (url) => ({
        url,
        response:
          attempt === 1
            ? await headManagedAssetUrl(url)
            : await probeManagedAssetUrl(url, { attempts: 1, delayMs: 0 }),
      }),
    );

    const missing = [];
    const retryable = [];
    for (const { url, response } of responses) {
      if (response.ok) {
        continue;
      }

      if (
        attempt < retryPolicy.attempts &&
        CI_RETRYABLE_STATUSES.has(response.status)
      ) {
        retryable.push(url);
        continue;
      }

      missing.push(`${response.status} ${url}`);
    }
    lastMissing = missing;

    if (missing.length > 0 && retryable.length === 0) {
      return missing;
    }

    if (retryable.length === 0) {
      return [];
    }

    pending = retryable;
    if (retryPolicy.delayMs > 0) {
      await delay(retryPolicy.delayMs);
    }
  }

  return lastMissing;
}

/**
 * Probe whether a git ref is resolvable on raw.githubusercontent.com.
 * Returns true if at least one well-known path returns 200.
 */
async function isRefAccessible(repository, ref) {
  const probeUrl = `https://raw.githubusercontent.com/${repository}/${ref}/package.json`;
  try {
    const res = await fetch(probeUrl, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export function resolveCurrentGitSha({
  cwd = repoRoot,
  env = process.env,
} = {}) {
  const explicit = env.GITHUB_SHA?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export function resolveValidationGitRef({
  cwd = repoRoot,
  env = process.env,
} = {}) {
  return resolveElizaReleaseTag({ env }) || resolveCurrentGitSha({ cwd, env });
}

export async function main({ cwd = repoRoot, env = process.env } = {}) {
  // Fail closed on bad policy before manifest I/O or network probes so a typo
  // cannot start validation under a different budget than requested.
  const retryPolicy = getValidationRetryPolicy({ env });

  const releaseTag = resolveElizaReleaseTag({ env });
  const gitSha = resolveCurrentGitSha({ cwd, env });
  const explicitValidationRef = env.ELIZA_CDN_VALIDATION_REF?.trim();
  const repository = resolveElizaAssetRepository({ env });
  if (!releaseTag && !gitSha) {
    throw new Error(
      "Could not resolve release tag or git SHA for CDN validation. Set ELIZA_RELEASE_TAG / RELEASE_TAG or run inside a git checkout.",
    );
  }

  const manifestValidation = validateStaticAssetManifest(cwd);
  if (!manifestValidation.ok) {
    throw new Error(
      `Static asset manifest is ${manifestValidation.reason}. Run node packages/app-core/scripts/generate-static-asset-manifest.mjs.`,
    );
  }

  const manifest = readStaticAssetManifest(cwd);
  if (!manifest) {
    throw new Error("Static asset manifest is missing.");
  }

  // When validating before the tag is created (e.g. agent-release build
  // matrix runs before the publish step creates the tag), fall back to the
  // commit SHA so we still verify the assets exist in the repo at this
  // commit. raw.githubusercontent.com resolves any git ref — branch, tag,
  // or full SHA — so the check is equivalent.
  let effectiveRef = explicitValidationRef || releaseTag || gitSha;
  if (explicitValidationRef) {
    console.log(
      `validate-cdn-assets: validating against explicit ref ${explicitValidationRef}${releaseTag ? ` for pending tag ${releaseTag}` : ""}.`,
    );
  } else if (!releaseTag && gitSha) {
    console.log(
      `validate-cdn-assets: no release tag provided, validating against commit SHA ${gitSha.slice(0, 12)}.`,
    );
  } else if (releaseTag && !(await isRefAccessible(repository, releaseTag))) {
    if (gitSha && (await isRefAccessible(repository, gitSha))) {
      console.log(
        `validate-cdn-assets: tag ${releaseTag} not yet accessible, falling back to commit SHA ${gitSha.slice(0, 12)}.`,
      );
      effectiveRef = gitSha;
    }
  }

  const appAssetRoot = env.ELIZA_CDN_APP_ASSET_ROOT || "packages/app/public";
  const homepageAssetRoot =
    env.ELIZA_CDN_HOMEPAGE_ASSET_ROOT || "packages/homepage/public";
  const [missingApp, missingHomepage] = await Promise.all([
    validateGroup(manifest.app, {
      repository,
      releaseTag: effectiveRef,
      assetRoot: appAssetRoot,
      retryPolicy,
    }),
    validateGroup(manifest.homepage, {
      repository,
      releaseTag: effectiveRef,
      assetRoot: homepageAssetRoot,
      retryPolicy,
    }),
  ]);

  const missing = [...missingApp, ...missingHomepage];
  if (missing.length > 0) {
    console.error("validate-cdn-assets: missing CDN files:");
    for (const entry of missing) {
      console.error(`  - ${entry}`);
    }
    process.exit(1);
  }

  console.log(
    `validate-cdn-assets: verified ${manifest.app.length + manifest.homepage.length} managed asset URLs for ${effectiveRef}${releaseTag && effectiveRef !== releaseTag ? ` (tag ${releaseTag} pending)` : ""}.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const overrideRoot = process.env.ELIZA_CDN_ROOT_DIR;
  try {
    await main({
      cwd: overrideRoot ? path.resolve(overrideRoot) : repoRoot,
      env: process.env,
    });
  } catch (error) {
    // error-policy:J1 boundary translation — CLI exits non-zero with message
    console.error(
      `validate-cdn-assets: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
