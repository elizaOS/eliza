/**
 * Call context provider for the Voice Call plugin.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { VOICE_CALL_SERVICE_NAME } from "../constants";
import type { VoiceCallService } from "../service";

export const callContextProvider: Provider = {
  name: "voiceCallContext",
  description: "Provides information about the current voice call context",

  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    // Only provide context for voice call messages
    const content = message.content as Record<string, unknown>;
    if (content.source !== "voice-call") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const service = await runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);

    if (!service || !service.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: "false" },
        text: "",
      };
    }

    const settings = service.getSettings();
    const activeCalls = service.getActiveCalls();
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const currentCallId = stateData.callId as string | undefined;

    let currentCall;
    if (currentCallId) {
      const result = service.getCallStatus(currentCallId);
      if (result.found) {
        currentCall = result.call;
      }
    } else if (activeCalls.length > 0) {
      currentCall = activeCalls[activeCalls.length - 1];
    }

    const agentName = (state?.agentName as string) || "The agent";

    let responseText = `${agentName} has voice call capabilities via ${settings?.provider || "unknown"} provider.`;

    if (currentCall) {
      const direction = currentCall.direction === "inbound" ? "receiving" : "making";
      responseText = `${agentName} is ${direction} a phone call with ${currentCall.direction === "inbound" ? currentCall.from : currentCall.to}.`;
      responseText += ` The call is currently ${currentCall.state}.`;
    } else if (activeCalls.length === 0) {
      responseText += " No calls are currently active.";
    } else {
      responseText += ` There are ${activeCalls.length} active call(s).`;
    }

    return {
      data: {
        connected: true,
        provider: settings?.provider,
        fromNumber: settings?.fromNumber,
        activeCalls: activeCalls.length,
        currentCall: currentCall
          ? {
              callId: currentCall.callId,
              direction: currentCall.direction,
              state: currentCall.state,
              from: currentCall.from,
              to: currentCall.to,
              transcriptLength: currentCall.transcript.length,
            }
          : null,
        capabilities: {
          outbound: true,
          inbound: settings?.inboundPolicy !== "disabled",
          tts: !!settings?.tts?.provider,
        },
      },
      values: {
        connected: "true",
        provider: settings?.provider || "",
        fromNumber: settings?.fromNumber || "",
        activeCalls: String(activeCalls.length),
        currentCallId: currentCall?.callId || "",
        currentCallState: currentCall?.state || "",
      },
      text: responseText,
    };
  },
};
