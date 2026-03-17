/**
 * End call action for the Voice Call plugin.
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

export const endCallAction: Action = {
  name: "VOICE_CALL_END",
  similes: ["HANG_UP", "END_CALL", "DISCONNECT_CALL", "HANGUP"],
  description: "End an active voice call",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);
    return !!service?.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);

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
      // Try to end the most recent active call
      const activeCalls = service.getActiveCalls();
      if (activeCalls.length === 0) {
        if (callback) {
          callback({ text: "No active calls to end.", source: "voice-call" });
        }
        return { success: false, error: "No active calls to end" };
      }

      const mostRecentCall = activeCalls[activeCalls.length - 1];
      const result = await service.endCall(mostRecentCall.callId);

      if (!result.success) {
        if (callback) {
          callback({ text: `Failed to end call: ${result.error}`, source: "voice-call" });
        }
        return { success: false, error: result.error };
      }

      if (callback) {
        callback({ text: "Call ended.", source: "voice-call" });
      }
      return { success: true };
    }

    // End the specified call
    const result = await service.endCall(callId);

    if (!result.success) {
      if (callback) {
        callback({ text: `Failed to end call: ${result.error}`, source: "voice-call" });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      callback({ text: "Call ended.", source: "voice-call" });
    }

    return { success: true };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "End the call" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Ending the call now.",
          actions: ["VOICE_CALL_END"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Hang up" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Hanging up.",
          actions: ["VOICE_CALL_END"],
        },
      },
    ],
  ],
};
