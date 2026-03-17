/**
 * Speak to user action for the Voice Call plugin.
 *
 * Delivers a one-way message to the user on an active call (no listening).
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

export const speakToUserAction: Action = {
  name: "VOICE_CALL_SPEAK",
  similes: ["SPEAK_ON_CALL", "SAY_ON_CALL", "TELL_CALLER", "VOICE_SPEAK"],
  description:
    "Speak a message to the user on an active voice call (one-way, does not wait for response)",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);
    if (!service?.isConnected()) return false;
    return service.getActiveCalls().length > 0;
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

    // Extract parameters from state
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const callId = stateData.callId as string | undefined;
    const messageText = (stateData.message as string) || (stateData.text as string) || "";

    if (!messageText.trim()) {
      if (callback) {
        callback({
          text: "I need a message to speak to the call participant.",
          source: "voice-call",
        });
      }
      return { success: false, error: "Message is required for speak_to_user" };
    }

    // Resolve call ID: use provided, or fall back to most recent active call
    let targetCallId = callId;
    if (!targetCallId) {
      const activeCalls = service.getActiveCalls();
      if (activeCalls.length === 0) {
        if (callback) {
          callback({ text: "No active calls.", source: "voice-call" });
        }
        return { success: false, error: "No active calls" };
      }
      targetCallId = activeCalls[activeCalls.length - 1].callId;
    }

    // Speak to the user
    const result = await service.speak(targetCallId, messageText);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to speak on call: ${result.error}`,
          source: "voice-call",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      callback({
        text: `Spoke to call participant: "${messageText}"`,
        source: "voice-call",
      });
    }

    return {
      success: true,
      data: {
        callId: targetCallId,
        message: messageText,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell them to hold on a moment" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll let them know.",
          actions: ["VOICE_CALL_SPEAK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Say goodbye on the call" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Saying goodbye to the caller.",
          actions: ["VOICE_CALL_SPEAK"],
        },
      },
    ],
  ],
};
