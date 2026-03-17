/**
 * Make call action for the Voice Call plugin.
 * This is an alias for initiateCall with a more intuitive name.
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

/**
 * Action to make an outbound voice call.
 */
export const voiceCallMakeCallAction: Action = {
  name: "VOICE_CALL_MAKE",
  similes: [
    "MAKE_PHONE_CALL",
    "PLACE_CALL",
    "DIAL_NUMBER",
    "CALL_PHONE",
    "VOICE_DIAL",
    "PHONE_DIAL",
    "RING",
    "INITIATE_VOICE_CALL",
  ],
  description: "Make an outbound voice call to a phone number",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);
    return !!service?.isConnected();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<VoiceCallService>(VOICE_CALL_SERVICE_NAME);

    if (!service || !service.isConnected()) {
      if (callback) {
        callback({
          text: "Voice call service is not available. Please check the configuration.",
          source: "voice-call",
        });
      }
      return { success: false, error: "Voice call service is not available" };
    }

    // Extract parameters from state or message content
    const stateData = (state?.data || {}) as Record<string, unknown>;
    const messageContent = (message.content || {}) as Record<string, unknown>;

    // Try multiple sources for phone number
    const to =
      (stateData.to as string) ||
      (stateData.phoneNumber as string) ||
      (messageContent.to as string) ||
      (messageContent.phoneNumber as string) ||
      service.getSettings()?.toNumber;

    const messageText = (stateData.message as string) || (messageContent.message as string) || "";

    const mode =
      (stateData.mode as "notify" | "conversation") ||
      (messageContent.mode as "notify" | "conversation") ||
      undefined;

    if (!to) {
      if (callback) {
        callback({
          text: "I need a phone number to make the call. Please provide a number in E.164 format (e.g., +15550001234).",
          source: "voice-call",
        });
      }
      return { success: false, error: "Missing phone number" };
    }

    if (!isValidE164(to)) {
      if (callback) {
        callback({
          text: `The phone number "${to}" doesn't appear to be valid. Please use E.164 format (e.g., +15550001234).`,
          source: "voice-call",
        });
      }
      return { success: false, error: "Invalid phone number format" };
    }

    // Check for concurrent call limits
    const activeCalls = service.getActiveCalls();
    const maxConcurrent = service.getSettings()?.maxConcurrentCalls || 1;
    if (activeCalls.length >= maxConcurrent) {
      if (callback) {
        callback({
          text: `Cannot make call - maximum concurrent calls (${maxConcurrent}) reached. Please wait for an active call to end.`,
          source: "voice-call",
        });
      }
      return { success: false, error: "Maximum concurrent calls reached" };
    }

    // Make the call
    const result = await service.initiateCall(to, {
      message: messageText,
      mode,
    });

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to make call: ${result.error}`,
          source: "voice-call",
        });
      }
      return { success: false, error: result.error };
    }

    // Build success response
    const modeDescription =
      mode === "conversation" ? "interactive conversation" : "notification delivery";

    let successText = `Call initiated to ${to}. Call ID: ${result.callId}. Mode: ${modeDescription}.`;
    if (messageText) {
      successText += ` Message: "${messageText.substring(0, 50)}${messageText.length > 50 ? "..." : ""}"`;
    }

    if (callback) {
      callback({
        text: successText,
        source: "voice-call",
        data: {
          callId: result.callId,
          to,
          mode: mode || "notify",
        },
      });
    }

    return { success: true };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Make a voice call to +15551234567" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll call that number now.",
          actions: ["VOICE_CALL_MAKE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Call +15559876543 and remind them about the 3pm meeting" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll call and deliver that reminder message.",
          actions: ["VOICE_CALL_MAKE"],
        },
      },
    ],
  ],
};

// Re-export initiateCallAction for backward compatibility
export { initiateCallAction } from "./initiateCall";
