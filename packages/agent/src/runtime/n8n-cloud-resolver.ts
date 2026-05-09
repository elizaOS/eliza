/**
 * n8n cloud-token resolver.
 *
 * Mints a short-lived n8n API token from the Eliza Cloud gateway via
 * `POST {cloudBaseUrl}/api/v1/n8n/tokens` (auth: `Bearer <ELIZAOS_CLOUD_API_KEY>`).
 * The full Cloud key is NEVER passed through to the n8n plugin as
 * `WORKFLOW_API_KEY` — only the minted token. See
 * `docs/cloud/n8n-gateway-contract.md` (§4) for the wire shape.
 *
 * Cache file: `<stateDir>/n8n/cloud-token.json` containing
 *   { token, expiresAt, cloudBaseUrl }.
 *
 * The cache is reused if `expiresAt` is more than `CACHE_REUSE_MIN_MS_REMAINING`
 * in the future AND `cloudBaseUrl` matches the current resolved base. Otherwise
 * the resolver mints a fresh token, persists it mode-0600, and returns it.
 *
 * Failure modes (intentional):
 *   - 404 from the gateway endpoint: the gateway isn't deployed yet. Log
 *     `info` and return `null` so the caller falls through to the local
 *     sidecar.
 *   - 401/403: the cloud key is invalid or the user lacks the n8n product.
 *     Log `error` and return `null`.
 *   - Network error / timeout: retried once, then `warn` + `null` so the
 *     caller falls through to the local sidecar.
 *
 * @module n8n-cloud-resolver
 */
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "@elizaos/core";

const LOG_PREFIX = "[N8nCloudResolver]";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_REUSE_MIN_MS_REMAINING = 60_000;

export interface MintedN8nToken {
  token: string;
  expiresAt: string;
  cloudBaseUrl: string;
}

export interface ResolvedN8nCloud {
  /** Gateway URL the n8n plugin should use as `WORKFLOW_HOST`. */
  host: string;
  /** Minted scoped token to use as `WORKFLOW_API_KEY`. NOT the cloud key. */
  apiKey: string;
}

interface ResolverDeps {
  fetch?: typeof fetch;
  /** Override the cache file location. Default `<stateDir>/n8n/cloud-token.json`. */
  cachePath?: string;
  /** Current wall-clock time. Injected for deterministic tests. */
  now?: () => number;
}

/**
 * Strip `/api/v1/?$` and trailing slashes from a cloud base URL so we can
 * append our own `/api/v1/...` segments without duplication.
 */
function normalizeCloudBase(rawBase: string): string {
  // Defensive cap to avoid pathological config strings.
  const safeBase = rawBase.length > 8192 ? rawBase.slice(0, 8192) : rawBase;
  return safeBase.replace(/\/api\/v1\/?$/, "").replace(/\/{1,1024}$/, "");
}

function defaultCachePath(stateDir: string): string {
  return path.join(stateDir, "n8n", "cloud-token.json");
}

async function readCache(cachePath: string): Promise<MintedN8nToken | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<MintedN8nToken>;
  if (
    typeof candidate.token !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.cloudBaseUrl !== "string" ||
    candidate.token.length === 0 ||
    candidate.expiresAt.length === 0 ||
    candidate.cloudBaseUrl.length === 0
  ) {
    return null;
  }
  return {
    token: candidate.token,
    expiresAt: candidate.expiresAt,
    cloudBaseUrl: candidate.cloudBaseUrl,
  };
}

async function writeCache(
  cachePath: string,
  token: MintedN8nToken,
): Promise<void> {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Re-chmod defensively — `mkdir` mode is masked by umask on some platforms.
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.writeFile(cachePath, JSON.stringify(token, null, 2), {
    mode: 0o600,
  });
  await fs.chmod(cachePath, 0o600).catch(() => undefined);
}

interface MintCallResult {
  /** Successfully minted token, ready to cache + return. */
  ok?: { token: string; expiresAt: string };
  /** Gateway not deployed yet — fall through to sidecar without warning. */
  notDeployed?: true;
  /** Auth failure (401/403) — fall through to sidecar with error log. */
  authFailed?: { status: number };
  /** Transient failure (network/timeout/5xx). Caller decides retry. */
  transient?: { reason: string };
  /** Permanent server failure other than auth (4xx that's not 401/403/404). */
  permanent?: { status: number };
}

async function callMintEndpoint(
  fetchImpl: typeof fetch,
  cloudBaseUrl: string,
  cloudApiKey: string,
): Promise<MintCallResult> {
  const url = `${cloudBaseUrl}/api/v1/n8n/tokens`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cloudApiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ purpose: "milady-runtime" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      transient: {
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (res.status === 404) {
    return { notDeployed: true };
  }
  if (res.status === 401 || res.status === 403) {
    return { authFailed: { status: res.status } };
  }
  if (res.status >= 500 && res.status < 600) {
    return { transient: { reason: `gateway ${res.status}` } };
  }
  if (!res.ok) {
    return { permanent: { status: res.status } };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      transient: {
        reason: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (!body || typeof body !== "object") {
    return { transient: { reason: "non-object response body" } };
  }
  const candidate = body as { token?: unknown; expiresAt?: unknown };
  if (
    typeof candidate.token !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    candidate.token.length === 0 ||
    candidate.expiresAt.length === 0
  ) {
    return { transient: { reason: "missing token/expiresAt in response" } };
  }
  return { ok: { token: candidate.token, expiresAt: candidate.expiresAt } };
}

/**
 * Resolve the n8n cloud gateway URL + minted token.
 *
 * Returns `{ host, apiKey }` on success or `null` when the caller should
 * fall through to the local sidecar (404, 401/403, repeated network failures,
 * malformed response).
 *
 * On success, the host is `${cloudBaseUrl}/api/v1/n8n` (per gateway contract
 * §2 and §5). The apiKey is the minted scoped token, never the cloud key.
 */
export async function resolveN8nCloudToken(
  cloudApiKey: string,
  cloudBaseUrlRaw: string,
  stateDir: string,
  deps: ResolverDeps = {},
): Promise<ResolvedN8nCloud | null> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cloudBaseUrl = normalizeCloudBase(cloudBaseUrlRaw);
  const cachePath = deps.cachePath ?? defaultCachePath(stateDir);
  const host = `${cloudBaseUrl}/api/v1/n8n`;

  // Try the cache first.
  const cached = await readCache(cachePath);
  if (cached && cached.cloudBaseUrl === cloudBaseUrl) {
    const expiresAtMs = Date.parse(cached.expiresAt);
    if (
      Number.isFinite(expiresAtMs) &&
      expiresAtMs - now() > CACHE_REUSE_MIN_MS_REMAINING
    ) {
      return { host, apiKey: cached.token };
    }
  }

  // Mint a fresh token. Retry once on transient failure (network/5xx).
  let attempt = await callMintEndpoint(fetchImpl, cloudBaseUrl, cloudApiKey);
  if (attempt.transient) {
    logger.debug(
      `${LOG_PREFIX} mint transient failure (${attempt.transient.reason}); retrying once`,
    );
    attempt = await callMintEndpoint(fetchImpl, cloudBaseUrl, cloudApiKey);
  }

  if (attempt.ok) {
    const minted: MintedN8nToken = {
      token: attempt.ok.token,
      expiresAt: attempt.ok.expiresAt,
      cloudBaseUrl,
    };
    try {
      await writeCache(cachePath, minted);
    } catch (err) {
      logger.warn(
        `${LOG_PREFIX} failed to persist token cache: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    logger.info(`${LOG_PREFIX} Resolved via cloud-gateway`);
    return { host, apiKey: minted.token };
  }

  if (attempt.notDeployed) {
    logger.info(
      `${LOG_PREFIX} gateway endpoint /api/v1/n8n/tokens returned 404 — falling through to local sidecar`,
    );
    return null;
  }

  if (attempt.authFailed) {
    logger.error(
      `${LOG_PREFIX} cloud auth rejected (${attempt.authFailed.status}) — falling through to local sidecar`,
    );
    return null;
  }

  if (attempt.permanent) {
    logger.error(
      `${LOG_PREFIX} unexpected gateway status ${attempt.permanent.status} — falling through to local sidecar`,
    );
    return null;
  }

  logger.warn(
    `${LOG_PREFIX} gateway unreachable after retry (${attempt.transient?.reason ?? "unknown"}) — falling through to local sidecar`,
  );
  return null;
}

// Re-exported helper so tests can build deterministic state paths.
export const __testing = {
  defaultCachePath,
  normalizeCloudBase,
  CACHE_REUSE_MIN_MS_REMAINING,
};
