/**
 * Warm the existing Cloud connection and authenticated admission path before
 * an interactive turn. No prompt or model call is sent. Public CORS preflight
 * stays credential-free; this explicit host request warms only its own account.
 * Runs on foreground/chat/Talk events, once per URL and credential per minute.
 * It never schedules periodic traffic or delays the owner's actual request.
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

let lastWarm: { url: string; apiKey: string; at: number } | null = null;

export async function warmCloudInference(runtime: IAgentRuntime | null): Promise<CloudWarmResult> {
  // Only when this plugin registered a chat-brain handler: with
  // ELIZAOS_CLOUD_USE_INFERENCE=false (direct provider) there is nothing to warm.
  if (!runtime?.getModelRegistrations().some((r) => r.provider === CLOUD_PROVIDER && CLOUD_TEXT_MODEL_TYPES.has(r.modelType))) {
    return { warmed: false, reason: "not-cloud-text" };
  }
  const tuple = resolveCloudSdkAuthorityTuple(runtime);
  if (!tuple.outboundAllowed || !tuple.apiKey) return { warmed: false, reason: "not-cloud-text" };
  const url = `${tuple.apiBaseUrl.replace(/\/+$/, "")}/inference/warm`;
  if (!/^https?:\/\//.test(url)) return { warmed: false, reason: "unreachable" };
  const now = Date.now();
  if (lastWarm?.url === url && lastWarm.apiKey === tuple.apiKey && now - lastWarm.at < CLOUD_WARM_INTERVAL_MS) {
    return { warmed: false, reason: "debounced" };
  }
  // Claimed before the request so concurrent triggers and failures debounce too.
  lastWarm = { url, apiKey: tuple.apiKey, at: now };
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
