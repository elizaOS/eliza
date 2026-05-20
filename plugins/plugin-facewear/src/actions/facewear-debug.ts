import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { FACEWEAR_SERVICE_TYPE, FacewearService } from "../services/facewear-service.ts";
import { XR_SERVICE_TYPE, XRSessionService } from "../services/xr-session-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "../services/smartglasses-service.ts";

export const facewearDebugAction: Action = {
  name: "FACEWEAR_DEBUG",
  description: "Show diagnostics for all connected facewear devices.",
  similes: ["DEBUG_GLASSES", "DIAGNOSE_HEADSET", "FACEWEAR_DIAGNOSTICS", "CHECK_XR"],
  examples: [
    [
      { name: "{{user1}}", content: { text: "Debug my XR connection" } },
      { name: "{{user2}}", content: { text: "XR session service is running. No active connections." } },
    ],
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    const lines: string[] = ["**Facewear Diagnostics**\n"];

    const xrSvc = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
    if (xrSvc) {
      const conns = xrSvc.getConnections();
      lines.push(`**XR Session Service:** running`);
      lines.push(`**XR Connections:** ${conns.length}`);
      for (const c of conns) {
        lines.push(`  - ${c.id}: ${c.deviceType} (connected ${c.connectedAt.toISOString()})`);
      }
    } else {
      lines.push("**XR Session Service:** not running");
    }

    const sgSvc = runtime.getService(SMARTGLASSES_SERVICE_NAME);
    if (sgSvc) {
      lines.push(`**Smartglasses Service:** running`);
    } else {
      lines.push("**Smartglasses Service:** not running");
    }

    const fwSvc = runtime.getService<FacewearService>(FACEWEAR_SERVICE_TYPE);
    if (fwSvc) {
      const devices = fwSvc.getConnectedDevices();
      lines.push(`**Active Devices:** ${devices.length}`);
    }

    await callback?.({ text: lines.join("\n") });
    return { success: true };
  },
};
