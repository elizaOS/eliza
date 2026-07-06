/**
 * Programmatic credential repair for DEDICATED cloud agents (issue #15132).
 *
 * A dedicated agent container upgrade re-mints its `ELIZA_API_TOKEN`, so every
 * credential captured at pair/provision time — the sessionStorage
 * `eliza:cloud-pair:api-token` handoff, the boot-config `apiToken`, and the
 * persisted active-server `accessToken` — starts 401ing at the container even
 * though the user's *cloud* (Steward) session is still perfectly valid. Before
 * this module the only recovery was the manual "Open Web UI" popup from the
 * dashboard; the app itself dead-ended on the self-hosted password wall.
 *
 * `repairDedicatedAgentCredential` re-runs the pairing flow without a popup:
 *   1. gate — the client must point at `<agentId>.elizacloud.ai` AND a usable
 *      Steward session must exist (one refresh attempt if the stored JWT is
 *      stale). No cloud session → return false, which keeps LoginView
 *      reachable as the genuine last resort for credential-less self-hosted
 *      setups.
 *   2. mint — `POST /api/v1/eliza/agents/:id/pairing-token` on the
 *      control-plane API with the Steward Bearer (CORS-open, 202+Retry-After
 *      while the agent resumes) via the shared poll loop.
 *   3. exchange — GET the returned `/pair` URL with `Accept: application/json`;
 *      the agent-side relay (app-core `handleCloudPairRoute`) performs the
 *      server-side cloud exchange and answers `{ apiKey }` instead of the
 *      popup HTML.
 *   4. persist — write the fresh token everywhere the stale one lives so the
 *      very next authed call succeeds.
 *
 * Callers (useAuthStatus's 401 branch, the startup 401 branches) may fire in
 * bursts, so the repair is single-flight with a short result cache: a 401
 * storm runs exactly one network repair.
 */

import { logger } from "@elizaos/logger";
import {
  readStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { client as defaultClient } from "../api/client";
import type { ElizaClient } from "../api/client-base";
import {
  getCloudAuthToken,
  refreshCloudStewardSession,
  resolveDirectCloudControlPlaneApiBase,
} from "../api/client-cloud";
import { hasUsableStoredStewardToken } from "../state/cloud-steward-login";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { dedicatedCloudAgentIdFromBase } from "../utils/cloud-agent-base";
import { pollPairingTokenRedirectUrl } from "./pairing-token-poll";

/**
 * Same-tab handoff key written by the `/pair` HTML page and re-adopted on every
 * boot by `packages/app/src/main.tsx` (`applyCloudPairSessionToken`). The
 * repair must overwrite it or the next reload re-adopts the STALE token.
 */
const CLOUD_PAIR_SESSION_TOKEN_KEY = "eliza:cloud-pair:api-token";

/**
 * Mint budget. Shorter than the popup flow's 120s: the repair runs behind an
 * auth probe the user is actively waiting on, and the container is normally
 * already running (rotation implies a fresh upgrade) — a long resume is better
 * served by the next probe cycle re-entering the (cached) repair.
 */
const REPAIR_PAIRING_WAIT_MS = 60_000;

/**
 * How long a completed repair outcome is reused before a new network attempt
 * is allowed. Bounds the cost of a 401 storm (App auth probe + startup poll +
 * visibilitychange refetches all noticing the same dead credential at once)
 * to one repair per window.
 */
const REPAIR_RESULT_CACHE_MS = 15_000;

let inflightRepair: Promise<boolean> | null = null;
let lastCompletedAt = 0;
let lastResult = false;

/** Test-only: forget the single-flight/result-cache state between cases. */
export function __resetRepairAgentCredentialStateForTests(): void {
  inflightRepair = null;
  lastCompletedAt = 0;
  lastResult = false;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    // error-policy:J3 malformed URL input yields the explicit null signal.
    return null;
  }
}

/**
 * Steward refresh endpoint for the repair gate. On a dedicated agent subdomain
 * the SPA's own origin has no Steward routes (every path proxies to the
 * container), so the same-origin default would 404 — refresh against the
 * control-plane API, where the `.elizacloud.ai` HttpOnly refresh cookie still
 * travels (same-site). Everywhere else the same-origin default is correct.
 */
function resolveRepairStewardRefreshEndpoint(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!dedicatedCloudAgentIdFromBase(window.location.origin)) return undefined;
  return `${resolveDirectCloudControlPlaneApiBase()}${STEWARD_REFRESH_ENDPOINT}`;
}

/**
 * True when a usable Steward session exists, refreshing a stored-but-stale JWT
 * once. Without a cloud session the repair must NOT run: the 401 is then a
 * genuine "sign in" state (self-hosted direct access), not a rotation.
 */
async function ensureUsableStewardSession(): Promise<boolean> {
  if (hasUsableStoredStewardToken()) return true;
  const stored = readStoredStewardToken()?.trim();
  if (!stored) return false;
  const refreshed = await refreshCloudStewardSession({
    endpoint: resolveRepairStewardRefreshEndpoint(),
    // error-policy:J4 a failed refresh degrades to "no usable cloud session"
    // → the caller falls back to the designed LoginView state.
  }).catch(() => null);
  if (!refreshed?.token) return false;
  writeStoredStewardToken(refreshed.token);
  return hasUsableStoredStewardToken();
}

/** Extract the pair URL only when it actually carries a one-time token. */
function asPairExchangeUrl(redirectUrl: string): URL | null {
  try {
    const url = new URL(redirectUrl);
    if (!url.pathname.replace(/\/+$/, "").endsWith("/pair")) return null;
    if (!url.searchParams.get("token")?.trim()) return null;
    return url;
  } catch {
    // error-policy:J3 a malformed redirect URL is an explicit "cannot
    // exchange" signal; the repair reports failure instead of fetching it.
    return null;
  }
}

async function runRepair(targetClient: ElizaClient): Promise<boolean> {
  const base =
    targetClient.getBaseUrl().trim() ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const agentId = dedicatedCloudAgentIdFromBase(base);
  if (!agentId) return false;

  if (!(await ensureUsableStewardSession())) {
    logger.info(
      `[repair-agent-credential] no usable cloud session for agent=${agentId}; leaving the 401 to the login gate`,
    );
    return false;
  }

  const minted = await pollPairingTokenRedirectUrl({
    agentId,
    apiBase: resolveDirectCloudControlPlaneApiBase(),
    authToken: getCloudAuthToken(targetClient),
    maxWaitMs: REPAIR_PAIRING_WAIT_MS,
  });
  if (!minted.ok) {
    logger.warn(
      `[repair-agent-credential] pairing-token mint failed agent=${agentId} reason=${minted.reason} status=${minted.status ?? "n/a"}`,
    );
    return false;
  }

  const pairUrl = asPairExchangeUrl(minted.redirectUrl);
  if (!pairUrl) {
    // The cloud route returns a bare webUiUrl (no /pair?token=) for agents
    // whose container predates token pairing — nothing to exchange.
    logger.warn(
      `[repair-agent-credential] agent=${agentId} does not support token pairing (redirectUrl carries no token)`,
    );
    return false;
  }

  // `format=json` doubles the Accept header so the relay's popup-free mode
  // survives any intermediary that rewrites Accept.
  pairUrl.searchParams.set("format", "json");
  const exchange = await fetch(pairUrl.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!exchange.ok) {
    logger.warn(
      `[repair-agent-credential] /pair exchange failed agent=${agentId} status=${exchange.status}`,
    );
    return false;
  }
  const exchanged = (await exchange
    .json()
    // error-policy:J3 a non-JSON 2xx body reads as "no key returned" via the
    // explicit null → the apiKey type check below reports the failure.
    .catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey =
    typeof exchanged?.apiKey === "string" ? exchanged.apiKey.trim() : "";
  if (!apiKey) {
    logger.warn(
      `[repair-agent-credential] /pair exchange returned no apiKey agent=${agentId}`,
    );
    return false;
  }

  // Persist the fresh credential everywhere the stale one lives.
  // 1. Live client + boot-config apiToken (fetchWithCsrf/authMe read here).
  targetClient.setToken(apiKey);
  // 2. Same-tab pair handoff re-adopted by main.tsx on every boot.
  try {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(CLOUD_PAIR_SESSION_TOKEN_KEY, apiKey);
    }
  } catch (err) {
    // error-policy:J4 sessionStorage can be unavailable in hardened browser
    // contexts — the in-memory/boot-config token still repairs this session;
    // surface the persistence miss instead of swallowing it.
    logger.warn(
      `[repair-agent-credential] failed to persist pair session token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 3. Persisted active-server record, when it is the cloud record for this
  //    same agent base (startup-phase-restore hands its accessToken to the
  //    client when no Steward token is available).
  const persisted = loadPersistedActiveServer();
  if (
    persisted?.kind === "cloud" &&
    persisted.apiBase &&
    originOf(persisted.apiBase) !== null &&
    originOf(persisted.apiBase) === originOf(base)
  ) {
    savePersistedActiveServer({ ...persisted, accessToken: apiKey });
  }

  logger.info(
    `[repair-agent-credential] refreshed rotated container credential agent=${agentId}`,
  );
  return true;
}

/**
 * Re-pair a dedicated cloud agent whose container credential rotated.
 * Returns `true` when a fresh `ELIZA_API_TOKEN` was minted, exchanged, and
 * persisted (the caller should retry the 401'd request); `false` when this
 * client is not a dedicated cloud agent, no usable cloud session exists, or
 * the repair failed — the caller falls back to its existing 401 handling
 * (LoginView / pairing gate), so self-hosted setups are unaffected.
 */
export async function repairDedicatedAgentCredential(
  targetClient: ElizaClient = defaultClient,
): Promise<boolean> {
  if (inflightRepair) return inflightRepair;
  if (Date.now() - lastCompletedAt < REPAIR_RESULT_CACHE_MS) return lastResult;

  inflightRepair = (async () => {
    try {
      return await runRepair(targetClient);
    } catch (err) {
      // error-policy:J1 repair boundary — a network/transport failure inside
      // the repair must degrade to the caller's designed 401 handling
      // (LoginView), never crash the auth probe or startup loop.
      logger.warn(
        `[repair-agent-credential] repair attempt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  })()
    .then((result) => {
      // Record the outcome BEFORE releasing the single-flight slot so a caller
      // arriving between settle and release still hits the result cache.
      lastCompletedAt = Date.now();
      lastResult = result;
      return result;
    })
    .finally(() => {
      inflightRepair = null;
    });

  return inflightRepair;
}
