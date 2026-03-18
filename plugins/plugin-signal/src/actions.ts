/**
 * Signal actions for the elizaOS agent.
 *
 * Provides a SEND_SIGNAL_MESSAGE action so the agent can proactively
 * send messages to Signal contacts by phone number or UUID.
 */

import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  TargetInfo,
} from "@elizaos/core";

export const sendSignalMessage: Action = {
  name: "SEND_SIGNAL_MESSAGE",

  description:
    "Send a text message to a phone number or UUID on Signal. Use this when the user asks you to send a Signal message to someone.",

  similes: [
    "SIGNAL_MESSAGE",
    "TEXT_ON_SIGNAL",
    "MESSAGE_ON_SIGNAL",
    "SEND_SIGNAL",
  ],

  parameters: [
    {
      name: "phoneNumber",
      description:
        "The recipient's phone number in international format (e.g. +1234567890) or their Signal UUID.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "message",
      description: "The text message to send.",
      required: true,
      schema: { type: "string" },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    return runtime.hasService("signal");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    const params = options?.parameters as
      | { phoneNumber?: string; message?: string }
      | undefined;

    const phoneNumber = params?.phoneNumber;
    const messageText = params?.message;

    if (!phoneNumber || !messageText) {
      runtime.logger.warn(
        "[signal] SEND_SIGNAL_MESSAGE missing phoneNumber or message params",
      );
      if (callback) {
        await callback({
          text: "I need both a phone number (or UUID) and a message to send on Signal.",
          actions: [],
        } as Content);
      }
      return { success: false };
    }

    try {
      await runtime.sendMessageToTarget(
        {
          source: "signal",
          channelId: phoneNumber,
          roomId: message.roomId,
        } as unknown as TargetInfo,
        {
          text: messageText,
        } as Content,
      );

      runtime.logger.info(
        `[signal] Sent message to ${phoneNumber} via SEND_SIGNAL_MESSAGE action`,
      );

      if (callback) {
        await callback({
          text: `Message sent to ${phoneNumber} on Signal.`,
          actions: [],
        } as Content);
      }

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      runtime.logger.error(`[signal] Failed to send Signal message: ${errMsg}`);

      if (callback) {
        await callback({
          text: `Failed to send Signal message: ${errMsg}`,
          actions: [],
        } as Content);
      }

      return { success: false };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a Signal message to +1234567890 saying hello",
        },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that Signal message now.",
          actions: ["SEND_SIGNAL_MESSAGE"],
        },
      } as ActionExample,
    ],
  ],
};
