/**
 * Queries the npm registry for new elizaos versions on the user's
 * configured release channel (stable/beta/nightly).
 */

import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import type { ReleaseChannel, UpdateConfig } from "../config/types.eliza.ts";
import { VERSION } from "../runtime/version.ts";
import { compareSemver } from "./version-compat.ts";

const CHECK_INTERVAL_SECONDS = 14_400; // 4 hours
const REGISTRY_TIMEOUT_MS = 8_000;
const NPM_REGISTRY_PACKUMENT_URL = "https://registry.npmjs.org/elizaos";

/** npm dist-tag corresponding to each release channel. */
export const CHANNEL_DIST_TAGS: Readonly<Record<ReleaseChannel, string>> = {
  stable: "latest",
  beta: "beta",
  nightly: "nightly",
};

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: ReleaseChannel;
  distTag: string;
  /** True when the result came from the interval cache, not a live fetch. */
  cached: boolean;
  error: string | null;
}

/** Fetch dist-tags from the npm registry. Returns null on any failure. */
async function fetchDistTags(): Promise<Record<string, string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);

  try {
    const res = await fetch(NPM_REGISTRY_PACKUMENT_URL, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { "dist-tags": Record<string, string> };
    return data["dist-tags"] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function shouldSkipCheck(cfg: UpdateConfig | undefined): boolean {
  if (!cfg?.lastCheckAt) return false;
  const interval = cfg.checkIntervalSeconds ?? CHECK_INTERVAL_SECONDS;
  const elapsed = (Date.now() - new Date(cfg.lastCheckAt).getTime()) / 1_000;
  return elapsed < interval;
}

/** Resolve the effective release channel from config, env, or default. */
export function resolveChannel(cfg: UpdateConfig | undefined): ReleaseChannel {
  const env = process.env.ELIZA_UPDATE_CHANNEL?.trim().toLowerCase();
  if (env === "stable" || env === "beta" || env === "nightly") return env;
  return cfg?.channel ?? "stable";
}

/**
 * Check whether a newer version is available.
 * Respects the check interval; pass `force: true` to bypass.
 */
export async function checkForUpdate(options?: {
  force?: boolean;
}): Promise<UpdateCheckResult> {
  const config = loadElizaConfig();
  const updateCfg = config.update;
  const channel = resolveChannel(updateCfg);
  const distTag = CHANNEL_DIST_TAGS[channel];

  if (!options?.force && shouldSkipCheck(updateCfg)) {
    return {
      updateAvailable: updateCfg?.lastCheckVersion
        ? (compareSemver(VERSION, updateCfg.lastCheckVersion) ?? 0) < 0
        : false,
      currentVersion: VERSION,
      latestVersion: updateCfg?.lastCheckVersion ?? null,
      channel,
      distTag,
      cached: true,
      error: null,
    };
  }

  const distTags = await fetchDistTags();

  if (!distTags) {
    return {
      updateAvailable: false,
      currentVersion: VERSION,
      latestVersion: null,
      channel,
      distTag,
      cached: false,
      error: "Unable to reach the npm registry. Check your network connection.",
    };
  }

  const latestVersion = distTags[distTag] ?? null;

  if (!latestVersion) {
    return {
      updateAvailable: false,
      currentVersion: VERSION,
      latestVersion: null,
      channel,
      distTag,
      cached: false,
      error: `No version found for dist-tag "${distTag}". The "${channel}" channel may not have any published releases yet.`,
    };
  }

  const cmp = compareSemver(VERSION, latestVersion);
  const updateAvailable = cmp !== null && cmp < 0;

  try {
    saveElizaConfig({
      ...config,
      update: {
        ...config.update,
        lastCheckAt: new Date().toISOString(),
        lastCheckVersion: latestVersion,
      },
    });
  } catch (err) {
    // If config is unwritable the cache interval won't persist and the
    // registry gets queried on every startup — worth surfacing.
    const msg = String(err);
    process.stderr.write(
      `[eliza] Warning: could not save update-check metadata: ${msg}\n`,
    );
  }

  return {
    updateAvailable,
    currentVersion: VERSION,
    latestVersion,
    channel,
    distTag,
    cached: false,
    error: null,
  };
}

/** Returns the latest published version for each channel. */
export async function fetchAllChannelVersions(): Promise<
  Record<ReleaseChannel, string | null>
> {
  const distTags = await fetchDistTags();
  return {
    stable: distTags?.latest ?? null,
    beta: distTags?.beta ?? null,
    nightly: distTags?.nightly ?? null,
  };
}
