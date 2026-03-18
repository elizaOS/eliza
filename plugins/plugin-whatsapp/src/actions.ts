/**
 * WhatsApp actions for the elizaOS agent.
 *
 * Provides a SEND_WHATSAPP_MESSAGE action so the agent can proactively
 * send messages to WhatsApp contacts by phone number.
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

export const sendWhatsAppMessage: Action = {
  name: "SEND_WHATSAPP_MESSAGE",

  description:
    "Send a text message to a phone number on WhatsApp. Use this when the user asks you to send a WhatsApp message to someone.",

  similes: [
    "WHATSAPP_MESSAGE",
    "TEXT_ON_WHATSAPP",
    "MESSAGE_ON_WHATSAPP",
    "SEND_WHATSAPP",
    "WA_MESSAGE",
  ],

  parameters: [
    {
      name: "phoneNumber",
      description:
        "The recipient's phone number in international format (e.g. +1234567890). Include country code.",
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
    return runtime.hasService("whatsapp");
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
        "[whatsapp] SEND_WHATSAPP_MESSAGE missing phoneNumber or message params",
      );
      if (callback) {
        await callback({
          text: "I need both a phone number and a message to send on WhatsApp.",
          actions: [],
        } as Content);
      }
      return { success: false };
    }

    // Strip non-numeric chars from phone number (keep digits only)
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
    if (cleanPhone.length < 8) {
      if (callback) {
        await callback({
          text: `The phone number "${phoneNumber}" doesn't look valid. Please include the country code (e.g. +1234567890).`,
          actions: [],
        } as Content);
      }
      return { success: false };
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    try {
      await runtime.sendMessageToTarget(
        {
          source: "whatsapp",
          channelId: jid,
          roomId: message.roomId,
        } as unknown as TargetInfo,
        {
          text: messageText,
        } as Content,
      );

      runtime.logger.info(
        `[whatsapp] Sent message to +${cleanPhone} via SEND_WHATSAPP_MESSAGE action`,
      );

      if (callback) {
        await callback({
          text: `Message sent to +${cleanPhone} on WhatsApp.`,
          actions: [],
        } as Content);
      }

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      runtime.logger.error(
        `[whatsapp] Failed to send WhatsApp message: ${errMsg}`,
      );

      if (callback) {
        await callback({
          text: `Failed to send WhatsApp message: ${errMsg}`,
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
          text: "Send a WhatsApp message to +1234567890 saying hello, how are you?",
        },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that WhatsApp message now.",
          actions: ["SEND_WHATSAPP_MESSAGE"],
        },
      } as ActionExample,
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Text my friend on WhatsApp at +1234567890 and tell them I'll be late",
        },
      } as ActionExample,
      {
        name: "{{agent}}",
        content: {
          text: "Sending the message on WhatsApp.",
          actions: ["SEND_WHATSAPP_MESSAGE"],
        },
      } as ActionExample,
    ],
  ],
};
