/** Routes Discord messages to registered cloud agent servers. */

import {
  type GatewayRoutingRedis as CommonGatewayRoutingRedis,
  type GatewayWakeDependencies,
  observeGatewayWake,
  refreshGatewayActivity,
  resolveGatewayAgentServer,
  wakeGatewayServer,
} from "@elizaos/cloud-services-common/node";
import {
  executeGatewayForwardAttempts,
  type GatewayTargetResult,
  postGatewayTarget,
} from "@elizaos/cloud-services-common/transport";

import { getHashTargets, refreshHashRing } from "./hash-router";
import { logger } from "./logger";

export interface GatewayRoutingRedis extends CommonGatewayRoutingRedis {
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  expire(key: string, seconds: number): Promise<number>;
}

const KEDA_COOLDOWN_SECONDS = Number(process.env.KEDA_COOLDOWN_SECONDS ?? 900);
/**
 * A message forward runs an agent turn, which is not idempotent: an aborted
 * request keeps running on the agent server. Allow a full turn, as the
 * webhook gateway does, and never replay a timed-out or failed turn.
 */
const MESSAGE_FORWARD_TIMEOUT_MS = 75_000;
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_INCREMENT_MS = 1_000;

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

interface ServerRoute {
  serverName: string;
  serverUrl: string;
}

export async function resolveAgentServer(
  redis: Pick<GatewayRoutingRedis, "get">,
  agentId: string,
): Promise<ServerRoute | null> {
  const result = await resolveGatewayAgentServer(redis, agentId);
  return result.kind === "ready"
    ? { serverName: result.serverName, serverUrl: result.serverUrl }
    : null;
}

export function refreshKedaActivity(
  redis: Pick<GatewayRoutingRedis, "expire" | "lpush" | "ltrim">,
  serverName: string,
): Promise<void> {
  return refreshGatewayActivity(redis, serverName, KEDA_COOLDOWN_SECONDS);
}

export type WakeServerDependencies = Partial<GatewayWakeDependencies>;

export function wakeServer(
  serverName: string,
  serverUrl: string,
  dependencies: WakeServerDependencies = {},
): Promise<void> {
  return wakeGatewayServer(serverName, serverUrl, {
    ...dependencies,
    logError: dependencies.logError ?? logger.error.bind(logger),
  });
}

export function observeWakeServer(
  promise: Promise<void>,
  serverName: string,
  logError: GatewayWakeDependencies["logError"] = logger.error.bind(logger),
): void {
  observeGatewayWake(promise, serverName, logError);
}

/**
 * Forwards a message to an agent-server pod using consistent hash routing.
 * Same userId always hits the same pod (session affinity via hash ring).
 * On connection failure: refreshes DNS, retries on fallback pod.
 * On scaled-to-zero: triggers K8s wake-up and retries until pod is ready.
 * A timeout or a server error is final: the turn may already have run.
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

  return executeGatewayForwardAttempts({
    attempts: RETRY_ATTEMPTS,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    incrementMs: RETRY_INCREMENT_MS,
    getTargets: () => getHashTargets(serverUrl, userId, 2),
    refreshTargets: () => refreshHashRing(serverUrl),
    wake: () =>
      observeWakeServer(wakeServer(serverName, serverUrl), serverName),
    tryTarget: (target) => tryTarget(target, agentId, body),
    retryOnTimeout: false,
    exhaustedError: new Error("forwardToServer failed"),
  });
}

function tryTarget(
  target: string,
  agentId: string,
  body: string,
): Promise<GatewayTargetResult> {
  return postGatewayTarget({
    target,
    endpointPath: `/agents/${agentId}/message`,
    body,
    timeoutMs: messageForwardTimeoutMs,
    sharedSecret: process.env.AGENT_SERVER_SHARED_SECRET,
    timeoutError: new Error(
      `Agent forward timed out after ${messageForwardTimeoutMs}ms`,
    ),
    timeoutIsConnectionError: false,
    readResponse: async (response) => {
      const data = (await response.json()) as { response: string };
      return data.response;
    },
  });
}
