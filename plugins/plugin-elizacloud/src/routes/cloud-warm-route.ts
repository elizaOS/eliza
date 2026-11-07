/**
 * Cloud inference pre-warm (`POST /api/cloud/warm`).
 *
 * A client that is about to talk (app foregrounded, chat opened, Talk pressed)
 * asks the agent to open its Cloud connection before the first model call.
 * The agent sends ONE unauthenticated `OPTIONS` to the same
 * `<apiBaseUrl>/chat/completions` URL its text handlers use, on the process's
 * global fetch pool, so DNS/TCP/TLS are done and the first real `POST` reuses
 * the socket. No credential, no body, no model prompt. Cloud spreads requests
 * over a pool of workers, so this does not reliably absorb a worker's cold
 * start, and without a credential it cannot warm the gateway's auth cache.
 *
 * At most one warm per inference URL per {@link CLOUD_WARM_INTERVAL_MS}; a
 * debounced or skipped call answers immediately. The route always answers 200
 * with the outcome: a warm is advisory and its failure is never the caller's.
 */
import type http from "node:http";
import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";
import { sendJson } from "../lib/http";
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

let lastWarm: { url: string; at: number } | null = null;

export async function warmCloudInference(runtime: IAgentRuntime | null): Promise<CloudWarmResult> {
  // Only when this plugin registered a chat-brain handler: with
  // ELIZAOS_CLOUD_USE_INFERENCE=false (direct provider) there is nothing to warm.
  if (!runtime?.getModelRegistrations().some((r) => r.provider === CLOUD_PROVIDER && CLOUD_TEXT_MODEL_TYPES.has(r.modelType))) {
    return { warmed: false, reason: "not-cloud-text" };
  }
  const tuple = resolveCloudSdkAuthorityTuple(runtime);
  if (!tuple.outboundAllowed || !tuple.apiKey) return { warmed: false, reason: "not-cloud-text" };
  const url = `${tuple.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  if (!/^https?:\/\//.test(url)) return { warmed: false, reason: "unreachable" };
  const now = Date.now();
  if (lastWarm?.url === url && now - lastWarm.at < CLOUD_WARM_INTERVAL_MS) {
    return { warmed: false, reason: "debounced" };
  }
  // Claimed before the request so concurrent triggers and failures debounce too.
  lastWarm = { url, at: now };
  try {
    const response = await fetch(url, {
      method: "OPTIONS",
      redirect: "manual",
      signal: AbortSignal.timeout(CLOUD_WARM_TIMEOUT_MS),
    });
    // Drain so the socket returns to the keep-alive pool for the model call.
    await response.arrayBuffer();
    const durationMs = Date.now() - now;
    logger.debug(`[ELIZAOS_CLOUD] inference pre-warm status=${response.status} durationMs=${durationMs}`);
    return { warmed: true, status: response.status, durationMs };
  } catch (error) {
    logger.debug(`[ELIZAOS_CLOUD] inference pre-warm failed: ${error instanceof Error ? error.name : "unknown"}`);
    return { warmed: false, reason: "unreachable" };
  }
}

export async function handleCloudWarmRoute(_req: unknown, res: unknown, runtime: unknown): Promise<void> {
  sendJson(res as http.ServerResponse, await warmCloudInference((runtime as IAgentRuntime | null) ?? null));
}
