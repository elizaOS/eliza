/**
 * Cloud Bootstrap Plugin - Native planner message execution for cloud.
 * Replaces default message service with CloudBootstrapMessageService.
 */
import {
  EventType,
  type IAgentRuntime,
  logger,
  type Plugin,
  type RunEventPayload,
  Service,
} from "@elizaos/core";
import { oauthAction } from "../plugin-oauth/actions/oauth";
import { userAuthStatusProvider } from "../plugin-oauth/providers/user-auth-status";
import { appConfigProvider } from "../shared/providers/app-config";
import { recentMessagesProvider } from "../shared/providers/recent-messages";
import { finishAction } from "./actions/finish";
import { generateMediaAction } from "./actions/media-generation";
import { actionStateProvider } from "./providers/action-state";
import { actionsProvider } from "./providers/actions";
import { characterProvider } from "./providers/character";
import { CloudBootstrapMessageService } from "./services/cloud-bootstrap-message-service";
import { CloudMediaGenerationService } from "./services/cloud-media-generation-service";

// Re-export for external use
export { CloudBootstrapMessageService } from "./services/cloud-bootstrap-message-service";
export * from "./templates";
export * from "./types";
export * from "./utils";

/**
 * Installs CloudBootstrapMessageService after runtime.initialize() completes.
 * Must be a service (not plugin.init) to run after DefaultMessageService is assigned.
 */
class MessageServiceInstaller extends Service {
  static serviceType = "cloud-bootstrap-message-installer";
  capabilityDescription = "Installs CloudBootstrapMessageService after runtime initialization";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MessageServiceInstaller(runtime);

    // Replace DefaultMessageService with our custom implementation
    logger.info("[CloudBootstrap] Installing CloudBootstrapMessageService (post-initialization)");
    runtime.messageService = new CloudBootstrapMessageService();
    logger.info("[CloudBootstrap] CloudBootstrapMessageService installed");

    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {}
  async stop(): Promise<void> {}
}

// PERF: Track logged runIds to prevent duplicate log writes per run.
// Each run should only log RUN_STARTED once and RUN_ENDED/RUN_TIMEOUT once.
const loggedRunIds = new Map<string, Set<string>>();
const MAX_LOGGED_RUN_IDS = 500; // Prevent unbounded growth

function cleanupLoggedRunIds(): void {
  if (loggedRunIds.size > MAX_LOGGED_RUN_IDS) {
    // Remove oldest entries by Map insertion order (creation-time, not completion-time).
    // This is fine because run IDs are inserted on first encounter and we only need
    // approximate recency — evicting the first half is simple and O(n/2).
    const keys = Array.from(loggedRunIds.keys());
    const toRemove = keys.slice(0, Math.floor(keys.length / 2));
    for (const key of toRemove) {
      loggedRunIds.delete(key);
    }
  }
}

// PERF: Cap payload size to prevent >1MB log writes from blocking the pipeline
const MAX_LOG_BODY_SIZE = 10_000; // 10KB max for log body JSON

async function logRunEvent(payload: RunEventPayload): Promise<void> {
  const runId = payload.runId as string;
  const status = payload.status as string;

  // Deduplicate: skip if this runId+status combo was already logged
  if (!loggedRunIds.has(runId)) {
    loggedRunIds.set(runId, new Set());
    cleanupLoggedRunIds();
  }
  const loggedStatuses = loggedRunIds.get(runId);
  if (!loggedStatuses) return; // Shouldn't happen, but guard against it
  if (loggedStatuses.has(status)) {
    logger.debug(`[CloudBootstrap] Skipping duplicate log: runId=${runId} status=${status}`);
    return;
  }
  loggedStatuses.add(status);

  const body: Record<string, unknown> = {
    runId: payload.runId,
    status: payload.status,
    messageId: payload.messageId,
    roomId: payload.roomId,
    entityId: payload.entityId,
    startTime: payload.startTime,
    source: payload.source || "CloudBootstrapMessageService",
  };

  // Only include end-state fields when present
  if (payload.endTime !== undefined) body.endTime = payload.endTime;
  if (payload.duration !== undefined) body.duration = payload.duration;
  if (payload.error !== undefined) {
    // Cap error message size
    const errorStr = String(payload.error);
    body.error = errorStr.length > 1000 ? errorStr.substring(0, 1000) + "...(truncated)" : errorStr;
  }

  // PERF: Cap total payload size to prevent oversized writes from blocking.
  // If over limit, strip optional fields and truncate error further.
  const bodyJson = JSON.stringify(body);
  if (bodyJson.length > MAX_LOG_BODY_SIZE) {
    const originalSize = bodyJson.length;
    // Remove optional fields first
    delete body.endTime;
    delete body.duration;
    // Aggressively truncate error to 200 chars
    if (body.error) {
      const errStr = String(body.error);
      body.error = errStr.length > 200 ? errStr.substring(0, 200) + "...(truncated)" : errStr;
    }
    body._truncated = true;
    body._originalSize = originalSize;
    logger.warn(
      `[CloudBootstrap] Log payload truncated: ${originalSize} → ${JSON.stringify(body).length} bytes`,
    );
  }

  // PERF: Fire-and-forget -- don't await the log write. On serverless platforms
  // with tight execution budgets, work scheduled after the response may be dropped.
  payload.runtime
    .log({
      entityId: payload.entityId,
      roomId: payload.roomId,
      type: "run_event",
      body,
    })
    .catch((e) => {
      logger.warn(`[CloudBootstrap] Background log write failed: ${e}`);
    });
}

const createRunEventHandler = (eventType: string) => [
  async (payload: RunEventPayload) => {
    try {
      await logRunEvent(payload);
    } catch (error) {
      logger.debug(`[CloudBootstrap] Failed to log ${eventType}: ${error}`);
    }
  },
];

const events = {
  [EventType.RUN_STARTED]: createRunEventHandler("RUN_STARTED"),
  [EventType.RUN_ENDED]: createRunEventHandler("RUN_ENDED"),
  [EventType.RUN_TIMEOUT]: createRunEventHandler("RUN_TIMEOUT"),
};

export const cloudBootstrapPlugin: Plugin = {
  name: "cloud-bootstrap",
  description: "Native planner message execution with action params for cloud",
  actions: [
    generateMediaAction,
    finishAction,
    oauthAction,
  ] as Plugin["actions"],
  providers: [
    actionStateProvider,
    actionsProvider,
    characterProvider,
    recentMessagesProvider,
    userAuthStatusProvider,
    appConfigProvider,
  ],
  events,
  services: [MessageServiceInstaller, CloudMediaGenerationService],
};

export default cloudBootstrapPlugin;
