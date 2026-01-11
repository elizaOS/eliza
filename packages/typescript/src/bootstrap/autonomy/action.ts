/**
 * Autonomy Actions for elizaOS
 *
 * Actions that enable autonomous agent communication.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "../../types";
import { stringToUuid } from "../../utils";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service";

/**
 * Send to Admin Action
 *
 * Allows agent to send messages to admin from autonomous context.
 * Only available in autonomous room to prevent misuse.
 */
export const sendToAdminAction: Action = {
  name: "SEND_TO_ADMIN",
  description:
    "Send a message directly to the admin user from autonomous context",

  examples: [
    [
      {
        name: "Agent",
        content: {
          text: "I need to update the admin about my progress on the task.",
          action: "SEND_TO_ADMIN",
        },
      },
      {
        name: "Agent",
        content: {
          text: "Message sent to admin successfully.",
        },
      },
    ],
    [
      {
        name: "Agent",
        content: {
          text: "I should let the admin know I completed the analysis.",
          action: "SEND_TO_ADMIN",
        },
      },
      {
        name: "Agent",
        content: {
          text: "Admin has been notified of the analysis completion.",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    // Only allow this action in autonomous context
    const autonomyService = runtime.getService<AutonomyService>(
      AUTONOMY_SERVICE_TYPE,
    );
    if (!autonomyService) {
      return false;
    }

    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return false;
    }

    // Check if admin is configured
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return false;
    }

    // Check if message contains intention to communicate with admin
    const text = message.content.text?.toLowerCase() || "";
    const adminKeywords = [
      "admin",
      "user",
      "tell",
      "notify",
      "inform",
      "update",
      "message",
      "send",
      "communicate",
      "report",
      "alert",
    ];

    return adminKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // Double-check we're in autonomous context
    const autonomyService = runtime.getService<AutonomyService>(
      AUTONOMY_SERVICE_TYPE,
    );
    if (!autonomyService) {
      return {
        success: false,
        text: "Autonomy service not available",
        data: { error: "Service unavailable" },
      };
    }

    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return {
        success: false,
        text: "Send to admin only available in autonomous context",
        data: { error: "Invalid context" },
      };
    }

    // Get admin user ID
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return {
        success: false,
        text: "No admin user configured. Set ADMIN_USER_ID in settings.",
        data: { error: "No admin configured" },
      };
    }

    // Find target room
    const adminMessages = await runtime.getMemories({
      roomId: runtime.agentId,
      count: 10,
      tableName: "memories",
    });

    let targetRoomId: UUID;
    if (adminMessages && adminMessages.length > 0) {
      const lastMessage = adminMessages[adminMessages.length - 1];
      targetRoomId = lastMessage.roomId ?? runtime.agentId;
    } else {
      targetRoomId = runtime.agentId;
    }

    // Extract message content
    const autonomousThought = message.content.text || "";

    // Generate message to admin
    let messageToAdmin: string;
    if (
      autonomousThought.includes("completed") ||
      autonomousThought.includes("finished")
    ) {
      messageToAdmin = `I've completed a task and wanted to update you. My thoughts: ${autonomousThought}`;
    } else if (
      autonomousThought.includes("problem") ||
      autonomousThought.includes("issue") ||
      autonomousThought.includes("error")
    ) {
      messageToAdmin = `I encountered something that might need your attention: ${autonomousThought}`;
    } else if (
      autonomousThought.includes("question") ||
      autonomousThought.includes("unsure")
    ) {
      messageToAdmin = `I have a question and would appreciate your guidance: ${autonomousThought}`;
    } else {
      messageToAdmin = `Autonomous update: ${autonomousThought}`;
    }

    // Create and store message
    const adminMessage: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: runtime.agentId,
      roomId: targetRoomId,
      content: {
        text: messageToAdmin,
        source: "autonomy-to-admin",
        metadata: {
          type: "autonomous-to-admin-message",
          originalThought: autonomousThought,
          timestamp: Date.now(),
        },
      },
      createdAt: Date.now(),
    };

    await runtime.createMemory(adminMessage, "memories");

    const successMessage = `Message sent to admin in room ${targetRoomId.slice(0, 8)}...`;

    if (callback) {
      await callback({
        text: successMessage,
        data: {
          adminUserId,
          targetRoomId,
          messageContent: messageToAdmin,
        },
      });
    }

    return {
      success: true,
      text: successMessage,
      data: {
        adminUserId,
        targetRoomId,
        messageContent: messageToAdmin,
        sent: true,
      },
    };
  },
};
