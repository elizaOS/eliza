import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

export const xrContextProvider: Provider = {
  name: "XR_SESSION",
  description: "Provides context about connected XR headsets (Quest 3, XReal)",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const svc = runtime.getService<XRSessionService>(XR_SERVICE_TYPE);
    if (!svc?.hasActiveConnections()) return { text: "" };

    const conns = svc.getConnections();
    const deviceList = conns
      .map((c) => {
        const hasFrame = svc.getVisionPipeline().hasRecentFrame(c.id);
        return `${c.deviceType}${hasFrame ? " (camera active)" : ""}`;
      })
      .join(", ");

    const text = [
      `[XR devices connected: ${deviceList}]`,
      `[Audio streaming active — the user is speaking to you via their headset microphone.]`,
      `[Your text responses will be spoken aloud through the headset via TTS.]`,
      `[Use XR_QUERY_VISION to describe what the user's camera sees.]`,
    ].join("\n");

    return {
      text,
      values: {
        xrConnected: true,
        xrDevices: conns.map((c) => c.deviceType),
        xrConnectionCount: conns.length,
      },
    };
  },
};
