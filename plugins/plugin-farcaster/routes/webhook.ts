import type { IAgentRuntime, Route, RouteRequest, RouteResponse, UUID } from "@elizaos/core";
import type { FarcasterAgentManager } from "../managers/AgentManager";
import { FARCASTER_SERVICE_NAME, type NeynarWebhookData } from "../types";
import { readFarcasterAccountId } from "../utils/config";

type FarcasterWebhookService = {
  getManagerForAccount?: (
    accountId: string | undefined,
    agentId?: UUID
  ) => FarcasterAgentManager | undefined;
  getManagersForAgent?: (agentId?: UUID) => Map<string, FarcasterAgentManager>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNeynarWebhookData(value: unknown): value is NeynarWebhookData {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.data === undefined) return true;
  if (!isRecord(value.data)) return false;
  if (typeof value.data.hash !== "string") return false;
  if (!isRecord(value.data.author) || typeof value.data.author.fid !== "number") return false;
  if (value.data.text !== undefined && typeof value.data.text !== "string") {
    return false;
  }
  if (
    value.data.mentioned_profiles !== undefined &&
    !(
      Array.isArray(value.data.mentioned_profiles) &&
      value.data.mentioned_profiles.every(
        (profile) => isRecord(profile) && typeof profile.fid === "number"
      )
    )
  ) {
    return false;
  }
  if (value.data.parent_hash !== undefined && typeof value.data.parent_hash !== "string") {
    return false;
  }
  if (
    value.data.parent_author !== undefined &&
    !(isRecord(value.data.parent_author) && typeof value.data.parent_author.fid === "number")
  ) {
    return false;
  }
  return true;
}

export const farcasterWebhookRoutes: Route[] = [
  {
    type: "POST",
    name: "Farcaster Webhook Handler",
    path: "/webhook",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        if (!isNeynarWebhookData(req.body)) {
          res.status(400).json({
            success: false,
            error: "Invalid webhook payload",
          });
          return;
        }

        const webhookData = req.body;
        const eventType = webhookData.type;

        const farcasterService = runtime?.getService?.(FARCASTER_SERVICE_NAME) as
          | FarcasterWebhookService
          | undefined;
        const accountId = readFarcasterAccountId(webhookData);

        if (farcasterService && accountId) {
          const manager = farcasterService.getManagerForAccount?.(accountId, runtime.agentId);
          if (manager?.interactions.mode === "webhook") {
            await manager.interactions.processWebhookData(webhookData);
          }
        } else if (farcasterService) {
          const managers = farcasterService.getManagersForAgent?.(runtime.agentId) ?? new Map();
          await Promise.all(
            Array.from(managers.values())
              .filter((manager) => manager.interactions.mode === "webhook")
              .map((manager) => manager.interactions.processWebhookData(webhookData))
          );
        }

        res.status(200).json({
          success: true,
          message: "Webhook processed successfully",
          event_type: eventType,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        if (runtime.logger) {
          runtime.logger.error(
            error instanceof Error ? error : new Error(String(error)),
            "Webhook processing error"
          );
        }
        res.status(500).json({
          success: false,
          error: "Internal server error",
        });
      }
    },
  },
];
