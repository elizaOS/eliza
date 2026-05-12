import { readFileSync } from "fs";
import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";

const KEDA_COOLDOWN_SECONDS = Number(process.env.KEDA_COOLDOWN_SECONDS ?? 900);
const FORWARD_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;
const IDENTITY_CACHE_TTL_SECONDS = 300;
const IDENTITY_NEGATIVE_CACHE_TTL_SECONDS = 30;

interface ServerRoute {
  serverName: string;
  serverUrl: string;
}

export type RoutingRedis = Pick<GatewayRedis, "get" | "set" | "lpush" | "ltrim" | "expire">;

export interface ResolvedIdentity {
  userId: string;
  organizationId: string;
  agentId: string;
}

export async function resolveIdentity(
  redis: RoutingRedis,
  cloudBaseUrl: string,
  authHeader: Record<string, string>,
  platform: string,
  platformId: string,
  platformName?: string,
): Promise<ResolvedIdentity | null> {
  const cacheKey = `identity:${platform}:${platformId}`;
  const cached = await redis.get<ResolvedIdentity | { notFound: true }>(cacheKey);
  if (cached) {
    if ("notFound" in cached) return null;
    return cached;
  }

  let url = `${cloudBaseUrl}/api/internal/identity/resolve?platform=${encodeURIComponent(platform)}&platformId=${encodeURIComponent(platformId)}`;
  if (platformName) url += `&platformName=${encodeURIComponent(platformName)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: authHeader,
      signal: controller.signal,
    });
    if (res.status === 404) {
      await redis.set(cacheKey, JSON.stringify({ notFound: true }), {
        ex: IDENTITY_NEGATIVE_CACHE_TTL_SECONDS,
      });
      return null;
    }
    if (!res.ok) throw new Error(`Identity resolve failed: ${res.status}`);

    const data = (await res.json()) as {
      userId: string;
      organizationId: string;
      agentId: string;
    };
    const identity: ResolvedIdentity = {
      userId: data.userId,
      organizationId: data.organizationId,
      agentId: data.agentId,
    };
    await redis.set(cacheKey, JSON.stringify(identity), {
      ex: IDENTITY_CACHE_TTL_SECONDS,
    });
    return identity;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveAgentServer(
  redis: RoutingRedis,
  agentId: string,
): Promise<ServerRoute | null> {
  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return null;

  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  if (!serverUrl) return null;

  return { serverName, serverUrl };
}

export async function refreshKedaActivity(redis: RoutingRedis, serverName: string): Promise<void> {
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
    k8sToken = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf-8").trim();
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
    k8sCaCert = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf-8");
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

export async function wakeServer(serverName: string, serverUrl: string): Promise<void> {
  const token = getK8sToken();
  if (!token) return;

  const namespace = parseNamespaceFromUrl(serverUrl);
  if (!namespace) return;

  const apiUrl = `https://kubernetes.default.svc/apis/apps/v1/namespaces/${namespace}/deployments/${serverName}/scale`;

  try {
    const res = await fetch(apiUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/strategic-merge-patch+json",
      },
      body: JSON.stringify({ spec: { replicas: 1 } }),
      tls: { ca: getK8sCaCert() ?? undefined },
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text();
      logger.error("wakeServer failed", {
        serverName,
        status: res.status,
        body: text,
      });
    }
  } catch (err) {
    logger.error("wakeServer error", {
      serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  );
  const data = JSON.parse(raw) as { response: string };
  return data.response;
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
  );
}

type TargetResult =
  | { ok: true; response: string }
  | { ok: false; error: Error; isConnectionError: boolean };

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
): Promise<string> {
  let lastError: Error | null = null;
  let woken = false;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS + RETRY_INCREMENT_MS * attempt;
      await new Promise((r) => setTimeout(r, delay));
    }

    const targets = await getHashTargets(serverUrl, hashKey, 2);

    if (targets.length === 0) {
      if (!woken) {
        woken = true;
        wakeServer(serverName, serverUrl).catch(() => {});
      }
      lastError = new Error("No pods available (scaled to zero)");
      continue;
    }

    const result = await tryTarget(targets[0], endpointPath, body);
    if (result.ok) return result.response;

    if (targets.length > 1) {
      await refreshHashRing(serverUrl);
      const fallback = await tryTarget(targets[1], endpointPath, body);
      if (fallback.ok) return fallback.response;
    }

    lastError = result.error;
    if (!woken && result.isConnectionError) {
      woken = true;
      wakeServer(serverName, serverUrl).catch(() => {});
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
): Promise<TargetResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const sharedSecret = process.env.AGENT_SERVER_SHARED_SECRET;
  if (sharedSecret) {
    headers["X-Server-Token"] = sharedSecret;
  }

  try {
    const targetBase =
      target.startsWith("http://") || target.startsWith("https://") ? target : `http://${target}`;
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
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      isConnectionError: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
