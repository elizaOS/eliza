/**
 * Webhook route handler for Farcaster.
 */

import type { Route } from "@elizaos/core";

export const farcasterWebhookRoutes: Route[] = [
  {
    type: "POST",
    name: "Farcaster Webhook Handler",
    path: "/webhook",
    handler: async (req: { body: unknown }, res: { status: (code: number) => { json: (data: unknown) => void } }, runtime: { getService?: (name: string) => unknown; agentId?: string }) => {
      try {
        const webhookData = req.body as { type?: string };
        const eventType = webhookData.type;

        const farcasterService = runtime?.getService?.("farcaster") as {
          managers?: { get?: (id: string) => { interactions?: { mode?: string; processWebhookData?: (data: unknown) => Promise<void> } } };
        };

        if (farcasterService) {
          const agentManager = farcasterService.managers?.get?.(runtime.agentId ?? "");

          if (agentManager && agentManager.interactions) {
            if (agentManager.interactions.mode === "webhook") {
              console.log("Processing webhook through FarcasterInteractionManager...");
              await agentManager.interactions.processWebhookData?.(webhookData);
            } else {
              console.warn(
                `Agent is in ${agentManager.interactions.mode} mode, not webhook mode`
              );
            }
          } else {
            console.warn(`FarcasterAgentManager not found for agent ${runtime.agentId}`);
          }
        } else {
          console.warn("FarcasterService not found - webhook data logged only");
        }

        res.status(200).json({
          success: true,
          message: "Webhook processed successfully",
          event_type: eventType,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("Webhook processing error:", error);
        res.status(500).json({
          success: false,
          error: "Internal server error",
        });
      }
    },
  },
];

