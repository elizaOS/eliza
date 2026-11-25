/**
 * Warm the existing Cloud connection and authenticated admission path before
 * an interactive turn. The owner app may also request one fixed, one-token
 * model probe per resident runtime. No conversation content is included.
 * Connection warming is debounced per URL and credential.
 */

import { createHash } from "node:crypto";
import type http from "node:http";
import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";
import { readJsonBody, sendJson } from "../lib/http";
import { resolveCloudSdkAuthorityTuple } from "../utils/config";

export const CLOUD_WARM_INTERVAL_MS = 60_000;
const CLOUD_WARM_TIMEOUT_MS = 5_000;
// The plugin's load-bearing model-provider identity (index.ts `name`).
const CLOUD_PROVIDER = "elizaOSCloud";
const CLOUD_TEXT_MODEL_TYPES = new Set<string>([
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_SMALL,
]);

export type CloudWarmResult =
  | { warmed: true; status: number; durationMs: number }
  | { warmed: false; reason: "not-cloud-text" | "debounced" | "unreachable" };

const recentWarms = new Map<string, number>();
const primedRuntimes = new WeakSet<IAgentRuntime>();
const MAX_WARM_IDENTITIES = 256;

export async function warmCloudInference(runtime: IAgentRuntime | null): Promise<CloudWarmResult> {
  // Only when this plugin registered a chat-brain handler: with
  // ELIZAOS_CLOUD_USE_INFERENCE=false (direct provider) there is nothing to warm.
  if (
    !runtime
      ?.getModelRegistrations()
      .some((r) => r.provider === CLOUD_PROVIDER && CLOUD_TEXT_MODEL_TYPES.has(r.modelType))
  ) {
    return { warmed: false, reason: "not-cloud-text" };
  }
  const tuple = resolveCloudSdkAuthorityTuple(runtime);
  if (!tuple.outboundAllowed || !tuple.apiKey) return { warmed: false, reason: "not-cloud-text" };
  const url = `${tuple.apiBaseUrl.replace(/\/+$/, "")}/inference/warm`;
  if (!/^https?:\/\//.test(url)) return { warmed: false, reason: "unreachable" };
  const now = Date.now();
  const identity = createHash("sha256").update(url).update("\0").update(tuple.apiKey).digest("hex");
  for (const [key, at] of recentWarms)
    if (now - at >= CLOUD_WARM_INTERVAL_MS) recentWarms.delete(key);
  if (recentWarms.has(identity)) return { warmed: false, reason: "debounced" };
  // Bound the cache and retain no raw credential. A changed key gets its own warmup.
  if (recentWarms.size >= MAX_WARM_IDENTITIES) {
    const oldest = recentWarms.keys().next().value;
    if (oldest !== undefined) recentWarms.delete(oldest);
  }
  // Claimed before the request so concurrent triggers and failures debounce too.
  recentWarms.set(identity, now);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tuple.apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(CLOUD_WARM_TIMEOUT_MS),
    });
    // Drain so the socket returns to the keep-alive pool for the model call.
    await response.arrayBuffer();
    if (!response.ok) return { warmed: false, reason: "unreachable" };
    const durationMs = Date.now() - now;
    logger.debug(
      `[ELIZAOS_CLOUD] inference pre-warm status=${response.status} durationMs=${durationMs}`
    );
    return { warmed: true, status: response.status, durationMs };
  } catch (error) {
    logger.debug(
      `[ELIZAOS_CLOUD] inference pre-warm failed: ${error instanceof Error ? error.name : "unknown"}`
    );
    return { warmed: false, reason: "unreachable" };
  }
}

export async function handleCloudWarmRoute(
  req: unknown,
  res: unknown,
  runtime: unknown
): Promise<void> {
  const response = res as http.ServerResponse;
  const body = await readJsonBody<{ primeModel?: boolean }>(req as http.IncomingMessage, response);
  if (!body) return;

  const agent = (runtime as IAgentRuntime | null) ?? null;
  const result = await warmCloudInference(agent);
  if (
    body.primeModel === true &&
    agent &&
    result.warmed &&
    !primedRuntimes.has(agent) &&
    agent.getModelRegistrations().some(
      (r) => r.provider === CLOUD_PROVIDER && r.modelType === ModelType.TEXT_SMALL
    )
  ) {
    primedRuntimes.add(agent);
    void agent.useModel(ModelType.TEXT_SMALL, {
      prompt: "Reply OK.",
      maxTokens: 1,
      temperature: 0,
      voiceOutput: "internal",
      signal: AbortSignal.timeout(CLOUD_WARM_TIMEOUT_MS),
    }, CLOUD_PROVIDER).catch(() => {
      logger.debug("[ELIZAOS_CLOUD] model pre-warm did not complete");
    });
  }
  sendJson(response, result);
}
