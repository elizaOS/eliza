/** Routes Discord messages to registered cloud agent servers. */

import { readFileSync } from "node:fs";
import { patchK8sDeploymentScale } from "@elizaos/cloud-services-common/k8s-deployment-wake";
import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";

const KEDA_COOLDOWN_SECONDS = Number(process.env.KEDA_COOLDOWN_SECONDS ?? 900);
const FORWARD_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;

interface ServerRoute {
  serverName: string;
  serverUrl: string;
}

export interface GatewayRoutingRedis {
  get<T = string>(key: string): Promise<T | null>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  expire(key: string, seconds: number): Promise<number>;
}

export async function resolveAgentServer(
  redis: Pick<GatewayRoutingRedis, "get">,
  agentId: string,
): Promise<ServerRoute | null> {
  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return null;

  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  if (!serverUrl) return null;

  return { serverName, serverUrl };
}

export async function refreshKedaActivity(
  redis: Pick<GatewayRoutingRedis, "expire" | "lpush" | "ltrim">,
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
  } catch {
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
  } catch {
    k8sCaCert = "";
  }
  return k8sCaCert || null;
}

function parseNamespaceFromUrl(serverUrl: string): string | null {
  // http://{name}.{namespace}.svc:{port}
  const match = serverUrl.match(/^https?:\/\/[^.]+\.([^.]+)\.svc/);
  return match?.[1] ?? null;
}

/**
 * Returns true when the server URL is a direct host:port endpoint (the
 * Hetzner-provisioned container model) rather than a K8s headless Service
 * (`{name}.{namespace}.svc`). Direct targets are already up — the
 * provisioning daemon manages their lifecycle — so there is no Deployment to
 * scale and `wakeServer` should return without issuing a scale request.
 */
function isDirectServerUrl(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl);
    return !(hostname.endsWith(".svc") || hostname.includes(".svc."));
  } catch {
    // Unparseable URL — treat as direct so we never attempt a K8s PATCH.
    return true;
  }
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
  // Hetzner containers (direct host:port URLs) are already running; there is
  // no K8s Deployment to scale. The gateways run on Railway, not K8s, so the
  // service-account token below is also absent there. Skip explicitly to
  // avoid both a pointless K8s API call and misleading error logs.
  if (isDirectServerUrl(serverUrl)) return;

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
 * Forwards a message to an agent-server pod using consistent hash routing.
 * Same userId always hits the same pod (session affinity via hash ring).
 * On connection failure: refreshes DNS, retries on fallback pod.
 * On scaled-to-zero: triggers K8s wake-up and retries until pod is ready.
 */
export async function forwardToServer(
  serverUrl: string,
  serverName: string,
  agentId: string,
  userId: string,
  text: string,
  options?: {
    senderName?: string;
    accountId?: string;
    platformRecordId?: string;
    chatId?: string;
    chatType?: string;
  },
): Promise<string> {
  const body = JSON.stringify({
    userId,
    text,
    platformName: "discord",
    ...(options?.senderName ? { senderName: options.senderName } : {}),
    ...(options?.accountId ? { accountId: options.accountId } : {}),
    ...(options?.platformRecordId
      ? { platformRecordId: options.platformRecordId }
      : {}),
    ...(options?.chatId ? { chatId: options.chatId } : {}),
    ...(options?.chatType ? { chatType: options.chatType } : {}),
  });

  let lastError: Error | null = null;
  let woken = false;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS + RETRY_INCREMENT_MS * attempt;
      await new Promise((r) => setTimeout(r, delay));
    }

    // Resolve target pod via consistent hash ring (DNS on headless Service)
    const targets = await getHashTargets(serverUrl, userId, 2);

    if (targets.length === 0) {
      if (!woken) {
        woken = true;
        observeWakeServer(wakeServer(serverName, serverUrl), serverName);
      }
      lastError = new Error("No pods available (scaled to zero)");
      continue;
    }

    const result = await tryTarget(targets[0], agentId, body);
    if (result.ok) return result.response;

    // Primary failed — refresh ring and try fallback
    if (targets.length > 1) {
      await refreshHashRing(serverUrl);
      const fallback = await tryTarget(targets[1], agentId, body);
      if (fallback.ok) return fallback.response;
    }

    lastError = result.error;
    if (!woken && result.isConnectionError) {
      woken = true;
      observeWakeServer(wakeServer(serverName, serverUrl), serverName);
    }
  }

  throw lastError ?? new Error("forwardToServer failed");
}

type TargetResult =
  | { ok: true; response: string }
  | { ok: false; error: Error; isConnectionError: boolean };

async function tryTarget(
  target: string,
  agentId: string,
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
      target.startsWith("http://") || target.startsWith("https://")
        ? target
        : `http://${target}`;
    const res = await fetch(`${targetBase}/agents/${agentId}/message`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json()) as { response: string };
      return { ok: true, response: data.response };
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
