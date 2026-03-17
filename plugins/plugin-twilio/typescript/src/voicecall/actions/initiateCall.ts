/**
 * Initiate call action for the Voice Call plugin.
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
import { isValidE164 } from "../types";

export const initiateCallAction: Action = {
  name: "VOICE_CALL_INITIATE",
  similes: ["PHONE_CALL", "CALL_USER", "DIAL"],
  description: "Initiate an outbound voice call",

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

    // Extract parameters from state or use defaults
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const to = (stateData.to as string) || service.getSettings()?.toNumber;
    const messageText = (stateData.message as string) || "";
    const mode = (stateData.mode as "notify" | "conversation") || undefined;

    if (!to || !isValidE164(to)) {
      if (callback) {
        callback({
          text: "I need a valid phone number to call. Please provide a number in E.164 format (e.g., +15550001234).",
          source: "voice-call",
        });
      }
      return { success: false, error: "Invalid phone number" };
    }

    // Initiate the call
    const result = await service.initiateCall(to, { message: messageText, mode });

    if (!result.success) {
      if (callback) {
        callback({ text: `Failed to initiate call: ${result.error}`, source: "voice-call" });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      const modeText = mode === "notify" ? "notification" : "conversation";
      callback({
        text: `Call initiated to ${to}. Call ID: ${result.callId}. Mode: ${modeText}.`,
        source: "voice-call",
      });
    }

    return { success: true };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Call +15551234567 and tell them the meeting is rescheduled to 3pm" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll call that number now with your message.",
          actions: ["VOICE_CALL_INITIATE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Start a phone call with my doctor" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll initiate a call. What's the phone number?",
          actions: [],
        },
      },
    ],
  ],
};
