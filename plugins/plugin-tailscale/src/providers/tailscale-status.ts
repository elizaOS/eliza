/**
 * tailscaleStatus provider — injects the current tunnel status into the LLM
 * context as compact JSON.
 *
 * Replaces the previous GET_TAILSCALE_STATUS action: status is now passively
 * available every turn so the planner does not need to dispatch a dedicated
 * action just to read tunnel state.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getTunnelService } from "../types";

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}, ${minutes % 60} minute${minutes % 60 === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const tailscaleStatusProvider: Provider = {
  name: "tailscaleStatus",
  description:
    "Current Tailscale tunnel status: active flag, public URL, local port, uptime, backend provider.",
  descriptionCompressed: "Tailscale tunnel status: active, url, port, uptime.",
  dynamic: true,
  contexts: ["settings", "connectors"],
  contextGate: { anyOf: ["settings", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) {
      return { text: "" };
    }

    const status = tunnelService.getStatus();
    const uptime = status.startedAt ? formatUptime(status.startedAt) : null;

    const text = JSON.stringify({
      tailscale: {
        active: status.active,
        url: status.url,
        port: status.port,
        uptime,
        provider: status.provider,
      },
    });

    return {
      text,
      values: {
        active: status.active,
        url: status.url ?? "",
        port: status.port ?? 0,
        provider: status.provider,
      },
      data: { status, uptime },
    };
  },
};
