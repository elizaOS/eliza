import {
  elizaLogger,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
} from "@elizaos/core";
import { getTunnelService } from "../types";

export const stopTailscaleAction: Action = {
  name: "STOP_TAILSCALE",
  similes: ["STOP_TUNNEL", "CLOSE_TUNNEL", "TAILSCALE_DOWN"],
  description: "Stop the running Tailscale tunnel",
  descriptionCompressed: "stop run Tailscale tunnel",
  validate: async (runtime: IAgentRuntime) =>
    Boolean(getTunnelService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    _options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) {
      if (callback) {
        await callback({ text: "Tunnel service is not available." });
      }
      return { success: false, error: "tunnel service unavailable" };
    }

    if (!tunnelService.isActive()) {
      elizaLogger.warn("[stop-tailscale] no active tunnel to stop");
      if (callback) {
        await callback({ text: "No tunnel is currently running." });
      }
      return {
        success: true,
        text: "no active tunnel",
        data: { action: "tunnel_not_active" },
      };
    }

    const status = tunnelService.getStatus();
    const previousUrl = status.url;
    const previousPort = status.port;

    await tunnelService.stopTunnel();

    if (callback) {
      await callback({
        text: `Tailscale tunnel stopped.\n\nWas running on port: ${previousPort}\nPrevious URL: ${previousUrl}`,
      });
    }
    return {
      success: true,
      text: `Tailscale tunnel stopped (was on port ${previousPort})`,
      data: {
        action: "tunnel_stopped",
        previousUrl: previousUrl ?? "",
        previousPort: previousPort ?? 0,
      },
    };
  },
  examples: [
    [
      { name: "user", content: { text: "Stop the tailscale tunnel" } },
      {
        name: "assistant",
        content: {
          text: "Tailscale tunnel stopped.\n\nWas running on port: 3000\nPrevious URL: https://device.tail-scale.ts.net",
          actions: ["STOP_TAILSCALE"],
        },
      },
    ],
  ],
};

export default stopTailscaleAction;
