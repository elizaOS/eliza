/**
 * Get call status action for the Voice Call plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { VOICE_CALL_SERVICE_NAME } from "../constants";
import type { VoiceCallService } from "../service";
import type { CallRecord } from "../types";

export const getCallStatusAction: Action = {
  name: "VOICE_CALL_STATUS",
  similes: ["CALL_STATUS", "CHECK_CALL", "CALL_INFO"],
  description: "Get the status of a voice call",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = await runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);
    return !!service?.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = await runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);

    if (!service || !service.isConnected()) {
      if (callback) {
        callback({ text: "Voice call service is not available.", source: "voice-call" });
      }
      return { success: false, error: "Voice call service is not available" };
    }

    // Get call ID from state
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const callId = stateData.callId as string;

    if (!callId) {
      // Return all active calls
      const activeCalls = service.getActiveCalls();

      if (activeCalls.length === 0) {
        if (callback) {
          callback({ text: "No active calls.", source: "voice-call" });
        }
        return { success: true };
      }

      const callList = activeCalls
        .map(
          (call: CallRecord) => `- ${call.callId}: ${call.direction} to ${call.to} (${call.state})`,
        )
        .join("\n");

      if (callback) {
        callback({
          text: `Active calls:\n${callList}`,
          source: "voice-call",
        });
      }
      return { success: true };
    }

    // Get specific call status
    const result = service.getCallStatus(callId);

    if (!result.found || !result.call) {
      if (callback) {
        callback({ text: `Call ${callId} not found.`, source: "voice-call" });
      }
      return { success: false, error: `Call ${callId} not found` };
    }

    const call = result.call;
    const duration = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;

    if (callback) {
      callback({
        text: `Call ${call.callId}:
- Direction: ${call.direction}
- State: ${call.state}
- From: ${call.from}
- To: ${call.to}
- Duration: ${duration}s
- Transcript entries: ${call.transcript.length}`,
        source: "voice-call",
      });
    }

    return { success: true };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's the status of my call?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check the call status.",
          actions: ["VOICE_CALL_STATUS"],
        },
      },
    ],
  ],
};
