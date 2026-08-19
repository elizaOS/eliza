/** Routes authenticated connector traffic to cloud identities and agent servers. */

import { readFileSync } from "node:fs";
import { patchK8sDeploymentScale } from "@elizaos/cloud-services-common/k8s-deployment-wake";
import { reacquireAuthHeader } from "./auth";
import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";

const KEDA_COOLDOWN_SECONDS = Number(process.env.KEDA_COOLDOWN_SECONDS ?? 900);
const FORWARD_TIMEOUT_MS = 30_000;
const MESSAGE_FORWARD_TIMEOUT_MS = 75_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;
const IDENTITY_CACHE_TTL_SECONDS = 300;
const AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DNS_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const CANONICAL_ROUTER_ORIGIN_BY_AGENT_DOMAIN: Readonly<
  Record<string, string>
> = Object.freeze({
  "cloud.eliza.app": "eliza-production-1.eliza.app",
  "cloud-staging.eliza.app": "eliza-staging-1.eliza.app",
});

interface CanonicalAgentFallbackTarget {
  baseUrl: string;
  forwardedHost?: string;
}

type CanonicalAgentFallbackEnv = Record<string, string | undefined>;

export interface CanonicalAgentRoutingConfiguration {
  agentBaseDomain: string;
  routerOriginHost: string;
}

interface ServerRoute {
  serverName: string;
  serverUrl: string;
}

export type RoutingRedis = Pick<
  GatewayRedis,
  "get" | "set" | "lpush" | "ltrim" | "expire"
>;

export interface ResolvedIdentity {
  userId: string;
  organizationId: string;
  // Null when the identity is linked to a cloud user that has no provisioned
  // agent yet. Callers must treat this as an onboarding/provisioning condition,
  // never as an agent-server routing target.
  agentId: string | null;
}

/** Resolves one of the two supported production/staging routing pairs. */
export function getCanonicalAgentRoutingConfiguration(
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentRoutingConfiguration | null {
  const routerOriginHost = env.AGENT_ROUTER_ORIGIN_HOST?.trim().toLowerCase();
  const agentBaseDomain =
    env.ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim().toLowerCase();
  if (!routerOriginHost || !agentBaseDomain) return null;
  if (
    !DNS_HOSTNAME_PATTERN.test(routerOriginHost) ||
    !DNS_HOSTNAME_PATTERN.test(agentBaseDomain) ||
    CANONICAL_ROUTER_ORIGIN_BY_AGENT_DOMAIN[agentBaseDomain] !==
      routerOriginHost
  ) {
    return null;
  }
  return { agentBaseDomain, routerOriginHost };
}

/** Rejects startup before health endpoints bind when routing is unsafe. */
export function requireCanonicalAgentRoutingConfiguration(
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentRoutingConfiguration {
  const configuration = getCanonicalAgentRoutingConfiguration(env);
  if (!configuration) {
    throw new Error(
      "AGENT_ROUTER_ORIGIN_HOST and ELIZA_CLOUD_AGENT_BASE_DOMAIN must be configured as an exact canonical production or staging pair",
    );
  }
  return configuration;
}

/** Resolves a validated public or router-origin fallback for a cloud agent. */
export function getCanonicalAgentFallbackTarget(
  agentId: string,
  env: CanonicalAgentFallbackEnv = process.env,
): CanonicalAgentFallbackTarget | null {
  if (!AGENT_ID_PATTERN.test(agentId)) return null;
  const normalizedAgentId = agentId.toLowerCase();
  const configuration = getCanonicalAgentRoutingConfiguration(env);
  if (!configuration) return null;
  const forwardedHost = `${normalizedAgentId}.${configuration.agentBaseDomain}`;
  if (!DNS_HOSTNAME_PATTERN.test(forwardedHost)) {
    return null;
  }
  return {
    baseUrl: `https://${configuration.routerOriginHost}/api`,
    forwardedHost,
  };
}

/** Returns the selected fallback base URL for compatibility callers. */
export function getCanonicalAgentFallbackBase(
  agentId: string,
  env: CanonicalAgentFallbackEnv = process.env,
): string | null {
  return getCanonicalAgentFallbackTarget(agentId, env)?.baseUrl ?? null;
}

export async function resolveIdentity(
  redis: RoutingRedis,
  cloudBaseUrl: string,
  authHeader: Record<string, string>,
  platform: string,
  platformId: string,
  platformName?: string,
  reauth: () => Promise<Record<string, string>> = reacquireAuthHeader,
): Promise<ResolvedIdentity | null> {
  const cacheKey = `identity:${platform}:${platformId}`;
  const cached = await redis.get<ResolvedIdentity | { notFound: true }>(
    cacheKey,
  );
  if (cached) {
    if ("notFound" in cached) return null;
    return cached;
  }

  const url = `${cloudBaseUrl}/api/internal/identity/resolve`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const body = JSON.stringify({
      platform,
      platformId,
      ...(platformName ? { platformName } : {}),
    });
    let res = await fetch(url, {
      method: "POST",
      headers: authHeader,
      body,
      signal: controller.signal,
    });
    // A Worker redeploy invalidates the gateway's token until its scheduled
    // refresh, up to ~48 minutes away — and this call runs post-ack, so every
    // 401 in that window is a user-visible silence. Re-bootstrap and retry
    // exactly once; a second 401 falls through to the error path below.
    if (res.status === 401) {
      const freshHeader = await reauth();
      res = await fetch(url, {
        method: "POST",
        headers: freshHeader,
        body,
        signal: controller.signal,
      });
    }
    if (res.status === 404) {
      // An unlinked sender can become linked while the browser onboarding flow
      // is open. Do not cache this transition state: the very next provider
      // message must observe the completed identity link.
      return null;
    }
    if (!res.ok) throw new Error(`Identity resolve failed: ${res.status}`);

    const data = (await res.json()) as
      | {
          userId?: string;
          organizationId?: string;
          agentId?: string | null;
          data?: {
            user?: { id?: string; organizationId?: string };
            agent?: { id?: string | null };
          };
        }
      | {
          success?: boolean;
        };
    const userId =
      "userId" in data
        ? data.userId
        : "data" in data
          ? data.data?.user?.id
          : undefined;
    const organizationId =
      "organizationId" in data
        ? data.organizationId
        : "data" in data
          ? data.data?.user?.organizationId
          : undefined;
    const agentId =
      "agentId" in data
        ? data.agentId
        : "data" in data
          ? (data.data?.agent?.id ?? undefined)
          : undefined;
    // agentId is legitimately null while provisioning is still in flight, so it
    // is not part of the resolution contract. Throwing here used to abort the
    // whole background message pass for a linked-but-unprovisioned user, which
    // dropped their message with no reply at all.
    if (!userId || !organizationId) {
      throw new Error(
        "Identity resolve response missing userId or organizationId",
      );
    }
    // The flat branch above passes the wire value through untouched, and the
    // wire value for "no sandbox" is `null`. Normalise once, here, so no caller
    // has to.
    const identity: ResolvedIdentity = {
      userId,
      organizationId,
      agentId: agentId ?? null,
    };
    // A linked account can gain its assigned agent at any moment during
    // provisioning. Cache only the stable user+agent route so the first message
    // after provisioning cannot be stranded behind a stale agentId:null entry.
    if (identity.agentId) {
      await redis.set(cacheKey, JSON.stringify(identity), {
        ex: IDENTITY_CACHE_TTL_SECONDS,
      });
    }
    return identity;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Why an agent could not be routed to, which is not one condition but two.
 *
 * `agent:<id>:server` is written by a booted container and lives 30 days, while
 * `server:<name>:url` is refreshed by the pod's heartbeat and expires after two
 * minutes. So a missing routing key means the agent has never come up, and a
 * present routing key with no URL means an established agent whose pod is down
 * or scaled to zero. Callers that treat "no route" as "not provisioned yet" —
 * and answer with onboarding — must only do so for `unregistered`.
 */
export type AgentServerLookup =
  | ({ kind: "ready" } & ServerRoute)
  | { kind: "unregistered" }
  | { kind: "unreachable"; serverName: string };

export async function resolveAgentServer(
  redis: RoutingRedis,
  agentId: string,
): Promise<AgentServerLookup> {
  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return { kind: "unregistered" };

  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  if (!serverUrl) return { kind: "unreachable", serverName };

  return { kind: "ready", serverName, serverUrl };
}

export async function refreshKedaActivity(
  redis: RoutingRedis,
  serverName: string,
): Promise<void> {
  const key = `keda:${serverName}:activity`;
  await redis.lpush(key, Date.now().toString());
  await redis.ltrim(key, 0, 0);
  await redis.expire(key, KEDA_COOLDOWN_SECONDS);
}

let k8sToken: string | null = null;
let k8sCaCert: string | null = null;

function getK8sToken(): string | null {
  if (k8sToken !== null) return k8sToken;
  try {
    k8sToken = readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "utf-8",
    ).trim();
  } catch (err) {
    logger.debug("K8s service account token not available", {
      error: err instanceof Error ? err.message : String(err),
    });
    k8sToken = "";
  }
  return k8sToken || null;
}

function getK8sCaCert(): string | null {
  if (k8sCaCert !== null) return k8sCaCert;
  try {
    k8sCaCert = readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      "utf-8",
    );
  } catch (err) {
    logger.debug("K8s CA cert not available", {
      error: err instanceof Error ? err.message : String(err),
    });
    k8sCaCert = "";
  }
  return k8sCaCert || null;
}

function parseNamespaceFromUrl(serverUrl: string): string | null {
  const match = serverUrl.match(/^https?:\/\/[^.]+\.([^.]+)\.svc/);
  return match?.[1] ?? null;
}

export interface WakeServerDependencies {
  getToken?: () => string | null;
  getCaCert?: () => string | null;
  fetchFn?: typeof fetch;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  logError?: (message: string, context: Record<string, unknown>) => void;
}

export async function wakeServer(
  serverName: string,
  serverUrl: string,
  dependencies: WakeServerDependencies = {},
): Promise<void> {
  const logError = dependencies.logError ?? logger.error.bind(logger);
  const token = (dependencies.getToken ?? getK8sToken)();
  if (!token) return;

  const namespace = parseNamespaceFromUrl(serverUrl);
  if (!namespace) return;

  try {
    const res = await patchK8sDeploymentScale({
      serverName,
      namespace,
      token,
      caCert: (dependencies.getCaCert ?? getK8sCaCert)(),
      fetchFn: dependencies.fetchFn,
      createTimeoutSignal: dependencies.createTimeoutSignal,
    });
    if (!res.ok) {
      const text = await res.text();
      logError("wakeServer failed", {
        serverName,
        status: res.status,
        body: text,
      });
    }
  } catch (err) {
    // error-policy:J1 Detached wake failures terminate at this logged boundary.
    logError("wakeServer error", {
      serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function observeWakeServer(
  promise: Promise<void>,
  serverName: string,
  logError: (
    message: string,
    context: Record<string, unknown>,
  ) => void = logger.error.bind(logger),
): void {
  // error-policy:J5 wakeServer observes expected failures internally; this
  // terminal observer records only an unexpected residual rejection.
  void promise.catch((err) => {
    logError("wakeServer unhandled error", {
      serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Optional platform metadata forwarded alongside the chat message so the
 * agent-server can personalize responses, identify the originating platform,
 * and route proactive replies back to the correct chat.
 */
export interface ForwardMessageOptions {
  /** Originating platform identifier (e.g. "telegram", "whatsapp", "twilio", "blooio"). */
  platformName?: string;
  /** Display name of the sender as reported by the platform adapter. */
  senderName?: string;
  /** Platform-specific chat/conversation ID for reply routing. */
  chatId?: string;
  /** Connector account or bot identity that received the platform record. */
  accountId?: string;
  /** Stable platform-native message/update id used for canonical dedupe. */
  platformRecordId?: string;
  /** Platform-native chat type when the adapter exposes it. */
  chatType?: string;
}

/**
 * Builds the JSON body for forwarding a message to the agent-server.
 * Only includes metadata fields that are truthy, keeping the payload
 * backward-compatible when no platform context is available.
 */
export function buildForwardBody(
  userId: string,
  text: string,
  options?: ForwardMessageOptions,
): { userId: string; text: string } & Partial<ForwardMessageOptions> {
  const body: {
    userId: string;
    text: string;
  } & Partial<ForwardMessageOptions> = {
    userId,
    text,
  };
  if (options?.platformName) body.platformName = options.platformName;
  if (options?.senderName) body.senderName = options.senderName;
  if (options?.chatId) body.chatId = options.chatId;
  if (options?.accountId) body.accountId = options.accountId;
  if (options?.platformRecordId)
    body.platformRecordId = options.platformRecordId;
  if (options?.chatType) body.chatType = options.chatType;
  return body;
}

/**
 * Forwards a chat message to the correct agent-server pod via hash-ring routing.
 * Parses the agent-server response to extract the `.response` field expected
 * by platform adapters (e.g. Telegram, WhatsApp sendReply).
 *
 * @param options - Optional platform metadata enriching the POST body with
 *   `platformName`, `senderName`, and `chatId` for downstream personalization
 *   and reply routing. Omitted fields are excluded from the payload.
 */
export async function forwardToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  text: string,
  options?: ForwardMessageOptions,
): Promise<string> {
  const body = buildForwardBody(userId, text, options);

  // senderName and chatId excluded from logs (PII — phone numbers, display names)
  logger.debug("Forwarding message to agent-server", {
    agentId,
    userId,
    platformName: options?.platformName,
  });

  const raw = await forwardWithRetry(
    serverUrl,
    serverName,
    userId,
    `/agents/${agentId}/message`,
    JSON.stringify(body),
    getCanonicalAgentFallbackTarget(agentId),
    {
      timeoutMs: messageForwardTimeoutMs,
      retryOnTimeout: false,
    },
  );
  return parseAgentResponse(raw, agentId);
}

/**
 * Parses and validates an agent-server message response.
 *
 * The agent-server contract is a JSON body with a string `response` field.
 * A 200 with a malformed body (non-JSON, missing `response`, or a non-string
 * `response`) is an upstream failure, not an empty reply: returning `undefined`
 * here would surface as success-shaped silence (adapters drop empty/undefined
 * text without erroring), hiding the fault from logs and the caller. Fail-closed
 * by throwing so `processMessage`'s catch logs a structured forward failure.
 */
export function parseAgentResponse(raw: string, agentId: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Agent-server returned non-JSON response for agent ${agentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const response = (data as { response?: unknown } | null)?.response;
  if (typeof response !== "string") {
    throw new Error(
      `Agent-server response for agent ${agentId} missing string "response" field (got ${typeof response})`,
    );
  }
  return response;
}

/**
 * Forwards an internal event to the correct agent-server pod via hash-ring routing.
 * Uses the same retry, wake, and fallback logic as message forwarding.
 *
 * Hash key is `userId` (not `agentId`) to maintain session affinity: the same
 * user's messages and events land on the same pod, keeping the conversation
 * context hot. For system-initiated events (e.g. cron) the caller supplies a
 * deterministic userId so that affinity still distributes across the ring.
 */
export async function forwardEventToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  type: "cron" | "notification" | "system",
  payload: Record<string, unknown>,
): Promise<string> {
  return forwardWithRetry(
    serverUrl,
    serverName,
    userId,
    `/agents/${agentId}/event`,
    JSON.stringify({ userId, type, payload }),
    getCanonicalAgentFallbackTarget(agentId),
  );
}

type TargetResult =
  | { ok: true; response: string }
  | {
      ok: false;
      error: Error;
      isConnectionError: boolean;
      timedOut: boolean;
      status?: number;
    };

interface ForwardAttemptPolicy {
  timeoutMs: number;
  retryOnTimeout: boolean;
}

let messageForwardTimeoutMs = MESSAGE_FORWARD_TIMEOUT_MS;

/** Test-only seam for proving timeout behavior without a production-length wait. */
export const __serverRouterTestHooks = {
  setMessageForwardTimeoutMs(timeoutMs: number): void {
    messageForwardTimeoutMs = timeoutMs;
  },
  resetMessageForwardTimeoutMs(): void {
    messageForwardTimeoutMs = MESSAGE_FORWARD_TIMEOUT_MS;
  },
} as const;

const RUNTIME_AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dedicated app hosts can expose a runtime agent id that differs from the
 * cloud sandbox id used for routing. Resolve that id only from the authenticated
 * canonical host, and only when exactly one running runtime is present.
 */
async function discoverCanonicalRuntimeAgentId(
  canonicalTarget: CanonicalAgentFallbackTarget,
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const sharedSecret = process.env.AGENT_SERVER_SHARED_SECRET;
  if (sharedSecret) headers["X-Server-Token"] = sharedSecret;
  if (canonicalTarget.forwardedHost) {
    headers["X-Forwarded-Host"] = canonicalTarget.forwardedHost;
  }

  try {
    const res = await fetch(
      `${canonicalTarget.baseUrl.replace(/\/$/, "")}/agents`,
      {
        headers,
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      agents?: Array<{ id?: unknown; status?: unknown }>;
    };
    const running = (data.agents ?? []).filter(
      (agent): agent is { id: string; status?: unknown } =>
        typeof agent.id === "string" &&
        RUNTIME_AGENT_ID_PATTERN.test(agent.id) &&
        agent.status === "running",
    );
    return running.length === 1 ? running[0].id : null;
  } catch {
    // error-policy:J4 Discovery is an optional compatibility path; the caller
    // retains and reports the original canonical forwarding failure.
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tryCanonicalTarget(
  canonicalTarget: CanonicalAgentFallbackTarget,
  endpointPath: string,
  body: string,
  policy: ForwardAttemptPolicy,
): Promise<TargetResult> {
  const direct = await tryTarget(
    canonicalTarget.baseUrl,
    endpointPath,
    body,
    canonicalTarget.forwardedHost,
    policy.timeoutMs,
  );
  if (direct.ok || direct.status !== 404) return direct;

  const match = endpointPath.match(/^\/agents\/[^/]+\/(message|event)$/);
  if (!match) return direct;

  const runtimeAgentId = await discoverCanonicalRuntimeAgentId(canonicalTarget);
  if (!runtimeAgentId) return direct;

  return tryTarget(
    canonicalTarget.baseUrl,
    `/agents/${encodeURIComponent(runtimeAgentId)}/${match[1]}`,
    body,
    canonicalTarget.forwardedHost,
    policy.timeoutMs,
  );
}

/**
 * Generic retry loop with hash-ring routing and KEDA wake-on-zero.
 * Resolves pod targets via the hash ring, retries with linear backoff,
 * falls back to a secondary target on failure, and triggers a K8s
 * scale-up when all pods are unavailable.
 */
async function forwardWithRetry(
  serverUrl: string,
  serverName: string,
  hashKey: string,
  endpointPath: string,
  body: string,
  connectionFallback?: CanonicalAgentFallbackTarget | null,
  policy: ForwardAttemptPolicy = {
    timeoutMs: FORWARD_TIMEOUT_MS,
    retryOnTimeout: true,
  },
): Promise<string> {
  let lastError: Error | null = null;
  let woken = false;
  let canonicalAttempted = false;

  // Dedicated Docker sandboxes self-register a public host:port in Redis for
  // compatibility, but production node firewalls intentionally do not expose
  // those high ports to Railway. Their supported ingress is the canonical
  // control-plane router over HTTPS. Prefer it before the Redis target so a
  // normal Telegram/DM turn does not spend its entire non-replay timeout on a
  // transport that cannot be reached from this service.
  if (connectionFallback && serverName.startsWith("sandbox-")) {
    canonicalAttempted = true;
    const canonical = await tryCanonicalTarget(
      connectionFallback,
      endpointPath,
      body,
      policy,
    );
    if (canonical.ok) return canonical.response;
    if (canonical.timedOut && !policy.retryOnTimeout) {
      throw canonical.error;
    }
    lastError = canonical.error;
  }

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS + RETRY_INCREMENT_MS * attempt;
      await new Promise((r) => setTimeout(r, delay));
    }

    const targets = await getHashTargets(serverUrl, hashKey, 2);

    if (targets.length === 0) {
      if (!woken) {
        woken = true;
        observeWakeServer(wakeServer(serverName, serverUrl), serverName);
      }
      lastError = new Error("No pods available (scaled to zero)");
      continue;
    }

    const result = await tryTarget(
      targets[0],
      endpointPath,
      body,
      undefined,
      policy.timeoutMs,
    );
    if (result.ok) return result.response;
    if (result.timedOut && !policy.retryOnTimeout) {
      throw result.error;
    }

    // Dedicated sandboxes can remain healthy behind their canonical hostname
    // while an old direct host:port is still being refreshed into Redis. Only
    // a transport failure may use this fixed-domain route: an HTTP response is
    // authoritative and must not be bypassed through a second ingress.
    if (
      result.isConnectionError &&
      connectionFallback &&
      !canonicalAttempted &&
      targets[0].replace(/\/$/, "") !==
        connectionFallback.baseUrl.replace(/\/$/, "")
    ) {
      canonicalAttempted = true;
      const canonical = await tryCanonicalTarget(
        connectionFallback,
        endpointPath,
        body,
        policy,
      );
      if (canonical.ok) return canonical.response;
      if (canonical.timedOut && !policy.retryOnTimeout) {
        throw canonical.error;
      }
      lastError = canonical.error;
    }

    if (targets.length > 1) {
      await refreshHashRing(serverUrl);
      const fallback = await tryTarget(
        targets[1],
        endpointPath,
        body,
        undefined,
        policy.timeoutMs,
      );
      if (fallback.ok) return fallback.response;
      if (fallback.timedOut && !policy.retryOnTimeout) {
        throw fallback.error;
      }
    }

    lastError = result.error;
    if (!woken && result.isConnectionError) {
      woken = true;
      observeWakeServer(wakeServer(serverName, serverUrl), serverName);
    }
  }

  throw lastError ?? new Error("Forward failed after retries");
}

/**
 * Attempts a single POST to a target pod IP at the given endpoint path.
 * Attaches X-Server-Token when AGENT_SERVER_SHARED_SECRET is configured.
 */
async function tryTarget(
  target: string,
  endpointPath: string,
  body: string,
  forwardedHost?: string,
  timeoutMs = FORWARD_TIMEOUT_MS,
): Promise<TargetResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () =>
      controller.abort(
        new Error(`Agent forward timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const sharedSecret = process.env.AGENT_SERVER_SHARED_SECRET;
  if (sharedSecret) {
    headers["X-Server-Token"] = sharedSecret;
  }
  if (forwardedHost) {
    headers["X-Forwarded-Host"] = forwardedHost;
  }

  try {
    const targetBase =
      target.startsWith("http://") || target.startsWith("https://")
        ? target
        : `http://${target}`;
    const res = await fetch(`${targetBase}${endpointPath}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      const text = await res.text();
      return { ok: true, response: text };
    }

    return {
      ok: false,
      error: new Error(`Server returned ${res.status}: ${await res.text()}`),
      isConnectionError: false,
      timedOut: false,
      status: res.status,
    };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      error:
        timedOut && controller.signal.reason instanceof Error
          ? controller.signal.reason
          : err instanceof Error
            ? err
            : new Error(String(err)),
      isConnectionError: !timedOut,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
