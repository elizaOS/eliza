/**
 * Cloud Bootstrap Plugin - Multi-step message execution for eliza-cloud-v2.
 * Replaces default message service with CloudBootstrapMessageService.
 */
import {
  type IAgentRuntime,
  type Plugin,
  Service,
  logger,
  EventType,
  type RunEventPayload,
} from "@elizaos/core";

import { CloudBootstrapMessageService } from "./services/cloud-bootstrap-message-service";
import { actionStateProvider, actionsProvider } from "./providers";
import { generateImageAction } from "./actions";
import { recentMessagesProvider } from "../shared/providers";
import { characterProvider } from "./providers/character";
import {
  oauthConnectAction,
  oauthListAction,
  oauthGetAction,
  oauthRevokeAction,
  userAuthStatusProvider,
} from "../plugin-oauth";

// Re-export for external use
export { CloudBootstrapMessageService } from "./services/cloud-bootstrap-message-service";
export * from "./types";
export * from "./templates";
export * from "./utils";

/**
 * Installs CloudBootstrapMessageService after runtime.initialize() completes.
 * Must be a service (not plugin.init) to run after DefaultMessageService is assigned.
 */
class MessageServiceInstaller extends Service {
  static serviceType = "cloud-bootstrap-message-installer";
  capabilityDescription =
    "Installs CloudBootstrapMessageService after runtime initialization";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MessageServiceInstaller(runtime);

    // Replace DefaultMessageService with our custom implementation
    logger.info(
      "[CloudBootstrap] Installing CloudBootstrapMessageService (post-initialization)"
    );
    runtime.messageService = new CloudBootstrapMessageService();
    logger.info("[CloudBootstrap] CloudBootstrapMessageService installed");

    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {}
  async stop(): Promise<void> {}
}

async function logRunEvent(payload: RunEventPayload): Promise<void> {
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
  if (payload.error !== undefined) body.error = payload.error;

  await payload.runtime.log({
    entityId: payload.entityId,
    roomId: payload.roomId,
    type: "run_event",
    body,
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
  description: "Multi-step message execution with action params for eliza-cloud-v2",
  actions: [
    generateImageAction,
    oauthConnectAction,
    oauthListAction,
    oauthGetAction,
    oauthRevokeAction,
  ],
  providers: [
    actionStateProvider,
    actionsProvider,
    characterProvider,
    recentMessagesProvider,
    userAuthStatusProvider,
  ],
  events,
  services: [MessageServiceInstaller],
};

export default cloudBootstrapPlugin;
