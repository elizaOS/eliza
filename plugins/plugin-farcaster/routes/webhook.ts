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

export const farcasterWebhookRoutes: Route[] = [
  {
    type: "POST",
    name: "Farcaster Webhook Handler",
    path: "/webhook",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const webhookData = req.body as unknown as NeynarWebhookData;
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
