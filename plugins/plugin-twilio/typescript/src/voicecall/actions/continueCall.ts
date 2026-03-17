/**
 * Continue call action for the Voice Call plugin.
 *
 * Speaks a prompt to the user, then waits for their response transcript.
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

export const continueCallAction: Action = {
  name: "VOICE_CALL_CONTINUE",
  similes: ["CONTINUE_CALL", "FOLLOW_UP_CALL", "ASK_ON_CALL", "VOICE_CONTINUE"],
  description:
    "Continue a voice call conversation: speak a prompt to the user and wait for their response",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = await runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);
    if (!service?.isConnected()) return false;
    // Must have at least one active call
    return service.getActiveCalls().length > 0;
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

    // Extract parameters from state
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const callId = stateData.callId as string | undefined;
    const prompt = (stateData.message as string) || (stateData.prompt as string) || "";

    if (!prompt.trim()) {
      if (callback) {
        callback({
          text: "I need a message to speak to the call participant before listening for their response.",
          source: "voice-call",
        });
      }
      return { success: false, error: "Message/prompt is required for continue_call" };
    }

    // Resolve call ID: use provided, or fall back to most recent active call
    let targetCallId = callId;
    if (!targetCallId) {
      const activeCalls = service.getActiveCalls();
      if (activeCalls.length === 0) {
        if (callback) {
          callback({ text: "No active calls to continue.", source: "voice-call" });
        }
        return { success: false, error: "No active calls" };
      }
      targetCallId = activeCalls[activeCalls.length - 1].callId;
    }

    // Continue the call: speak prompt, then wait for transcript
    const result = await service.continueCall(targetCallId, prompt);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to continue call: ${result.error}`,
          source: "voice-call",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      const transcriptText = result.transcript
        ? `User responded: "${result.transcript}"`
        : "User did not respond within the timeout.";
      callback({
        text: `Spoke to call participant and listened for response. ${transcriptText}`,
        source: "voice-call",
      });
    }

    return {
      success: true,
      data: {
        callId: targetCallId,
        transcript: result.transcript,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Ask them if they want to reschedule" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll ask them on the call and listen for their response.",
          actions: ["VOICE_CALL_CONTINUE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Follow up on the call and ask for their availability" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Continuing the conversation on the call.",
          actions: ["VOICE_CALL_CONTINUE"],
        },
      },
    ],
  ],
};
