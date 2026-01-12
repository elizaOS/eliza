import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";

export const farcasterWebhookRoutes: Route[] = [
  {
    type: "POST",
    name: "Farcaster Webhook Handler",
    path: "/webhook",
    handler: async (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => {
      try {
        const webhookData = req.body as { type?: string };
        const eventType = webhookData.type;

        const farcasterService = runtime?.getService?.("farcaster") as {
          managers?: {
            get?: (id: string) => {
              interactions?: {
                mode?: string;
                processWebhookData?: (data: { type?: string }) => Promise<void>;
              };
            };
          };
        };

        if (farcasterService) {
          const agentManager = farcasterService.managers?.get?.(runtime.agentId ?? "");

          if (agentManager?.interactions) {
            if (agentManager.interactions.mode === "webhook") {
              await agentManager.interactions.processWebhookData?.(webhookData);
            }
          }
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
