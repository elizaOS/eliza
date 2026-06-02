import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

export const xrQueryVisionAction: Action = {
  name: "XR_QUERY_VISION",
  description:
    "Describe what the user is currently looking at through their XR headset camera. Use this when the user asks 'what do you see', 'look at this', or any question about their surroundings.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const svc = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
    if (!svc?.hasActiveConnections()) return false;
    // At least one connection must have a recent frame
    return svc
      .getConnections()
      .some((c) => svc.getVisionPipeline().hasRecentFrame(c.id));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const svc = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
    if (!svc) {
      await callback?.({ text: "XR service is not running." });
      return undefined;
    }

    const conn = svc.getConnections().find((c) => c.roomId === message.roomId);

    if (!conn) {
      await callback?.({
        text: "No XR device connection found for this session.",
      });
      return undefined;
    }

    const description = await svc
      .getVisionPipeline()
      .describeFrame(runtime, conn.id);

    if (!description) {
      await callback?.({
        text: "No recent camera frame available from the XR device.",
      });
      return undefined;
    }

    await callback?.({ text: description });
    return undefined;
  },
};
