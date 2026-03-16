import type { Action, Content, HandlerOptions } from "@elizaos/core";

type MessageTransportService = {
  sendDirectMessage?: (
    targetEntityId: string,
    content: Content,
  ) => Promise<void>;
  sendRoomMessage?: (targetRoomId: string, content: Content) => Promise<void>;
};

export const sendMessageAction: Action = {
  name: "SEND_MESSAGE",
  similes: ["DM", "MESSAGE", "SEND_DM", "POST_MESSAGE"],
  description:
    "Send a message to a user or room on a specific platform/service using explicit parameters.",

  validate: async () => true,

  handler: async (runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const targetType =
      params?.targetType === "user" || params?.targetType === "room"
        ? params.targetType
        : null;
    const source =
      typeof params?.source === "string" ? params.source.trim() : "";
    const target =
      typeof params?.target === "string" ? params.target.trim() : "";
    const text = typeof params?.text === "string" ? params.text.trim() : "";

    if (!targetType || !source || !target || !text) {
      return {
        text: "SEND_MESSAGE requires targetType, source, target, and text parameters.",
        success: false,
        values: {
          success: false,
          error: "INVALID_PARAMETERS",
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType,
          source: source || null,
          target: target || null,
        },
      };
    }

    const service = runtime.getService(
      source,
    ) as MessageTransportService | null;
    if (!service) {
      return {
        text: `Message service '${source}' is not available.`,
        success: false,
        values: {
          success: false,
          error: "SERVICE_NOT_FOUND",
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType,
          source,
          target,
        },
      };
    }

    if (targetType === "user") {
      if (!service.sendDirectMessage) {
        return {
          text: `Direct messaging is not supported by '${source}'.`,
          success: false,
          values: {
            success: false,
            error: "DIRECT_MESSAGE_UNSUPPORTED",
          },
          data: {
            actionName: "SEND_MESSAGE",
            targetType,
            source,
            target,
          },
        };
      }
      await service.sendDirectMessage(target, { text, source });
      return {
        text: `Message sent to user ${target} on ${source}.`,
        success: true,
        values: {
          success: true,
          targetType,
          source,
          target,
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType,
          source,
          target,
          text,
        },
      };
    }

    if (!service.sendRoomMessage) {
      return {
        text: `Room messaging is not supported by '${source}'.`,
        success: false,
        values: {
          success: false,
          error: "ROOM_MESSAGE_UNSUPPORTED",
        },
        data: {
          actionName: "SEND_MESSAGE",
          targetType,
          source,
          target,
        },
      };
    }
    await service.sendRoomMessage(target, { text, source });
    return {
      text: `Message sent to room ${target} on ${source}.`,
      success: true,
      values: {
        success: true,
        targetType,
        source,
        target,
      },
      data: {
        actionName: "SEND_MESSAGE",
        targetType,
        source,
        target,
        text,
      },
    };
  },

  parameters: [
    {
      name: "targetType",
      description: "Target entity type: user or room.",
      required: true,
      schema: { type: "string" as const, enum: ["user", "room"] },
    },
    {
      name: "source",
      description: "Messaging source/service name (e.g. telegram, discord).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "Target identifier. For users: entity ID/username. For rooms: room ID/name.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Message text to send.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
