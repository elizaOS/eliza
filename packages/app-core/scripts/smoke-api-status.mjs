#!/usr/bin/env node

/**
 * Deployment smoke check for app origins.
 *
 * Fails fast when /api/status is missing (for example when an app shell is
 * accidentally deployed to a marketing/static origin).
 *
 * Usage:
 *   node scripts/smoke-api-status.mjs https://eliza.ai https://app.eliza.ai
 * or
 *   ELIZA_DEPLOY_BASE_URLS=https://eliza.ai,https://app.eliza.ai node scripts/smoke-api-status.mjs
 * or
 *   ELIZA_DEPLOY_BASE_URLS=https://eliza.ai,https://app.eliza.ai node scripts/smoke-api-status.mjs
 */

import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;

export function resolveBaseUrls(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const argvBases = argv.map((value) => value.trim()).filter(Boolean);
  const envList = [env.ELIZA_DEPLOY_BASE_URLS, env.ELIZA_DEPLOY_BASE_URLS]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const legacyEnv = env.ELIZA_DEPLOY_BASE_URL?.trim();
  if (legacyEnv) {
    envList.push(legacyEnv);
  }
  return argvBases.length > 0 ? argvBases : envList;
}

export async function runSmokeApiStatus(options = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = console.log,
    error = console.error,
  } = options;

  const bases = resolveBaseUrls(argv, env);
  if (bases.length === 0) {
    error(
      "[smoke-api-status] Missing base URLs. Pass args or set ELIZA_DEPLOY_BASE_URLS.",
    );
    return 2;
  }

  let hasFailure = false;

  for (const base of bases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL("/api/status", base).toString();
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        error(
          `[smoke-api-status] FAIL ${url} returned HTTP ${res.status} ${res.statusText}`,
        );
        hasFailure = true;
        continue;
      }

      const body = await res.json().catch(() => null);
      if (!body || typeof body.state !== "string") {
        error(
          `[smoke-api-status] FAIL ${url} responded without expected status payload.`,
        );
        hasFailure = true;
        continue;
      }

      log(`[smoke-api-status] OK ${url} state=${body.state}`);
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const msg = err instanceof Error ? err.message : String(err);
      if (timedOut) {
        error(`[smoke-api-status] FAIL ${base} timed out after ${timeoutMs}ms`);
      } else {
        error(`[smoke-api-status] FAIL ${base} ${msg}`);
      }
      hasFailure = true;
    } finally {
      clearTimeout(timer);
    }
  }

  return hasFailure ? 1 : 0;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
})();

if (isMain) {
  const exitCode = await runSmokeApiStatus();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
