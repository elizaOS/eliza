import {
  type Action,
  type ActionResult,
  asUUID,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

interface AutonomyService {
  getAutonomousRoomId?: () => string | undefined;
}

/**
 * Send to Admin Action - allows agent to send messages to admin from autonomous context
 * Only available in autonomous room to prevent misuse
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
    const autonomyService = runtime.getService("autonomy");
    if (!autonomyService) {
      return false; // Service not available
    }

    const autonomousRoomId = (
      autonomyService as AutonomyService
    ).getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return false; // Not in autonomous context
    }

    // Check if admin is configured
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return false; // No admin configured
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
    void _state; // State is currently unused but preserved for future compatibility
    void _options; // Options currently unused but retained for API parity

    // Double-check we're in autonomous context
    const autonomyService = runtime.getService("autonomy");
    if (!autonomyService) {
      return {
        success: false,
        text: "Autonomy service not available",
        data: { error: "Service unavailable" },
      };
    }

    const autonomousRoomId = (
      autonomyService as AutonomyService
    ).getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return {
        success: false,
        text: "Send to admin only available in autonomous context",
        data: { error: "Invalid context" },
      };
    }

    // Get admin user ID and find their room
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return {
        success: false,
        text: "No admin user configured. Set ADMIN_USER_ID in settings.",
        data: { error: "No admin configured" },
      };
    }

    /**
     * Find the most recent room where admin and agent have communicated.
     *
     * Since we can't directly query by entityId, use a fallback approach.
     */
    const adminMessages = await runtime.getMemories({
      roomId: runtime.agentId, // Use agent's default room as fallback
      count: 10,
      tableName: "memories",
    });

    let targetRoomId: UUID;
    const latestAdminMessage = adminMessages?.[adminMessages.length - 1];
    if (latestAdminMessage?.roomId) {
      // Use the room from the most recent admin message
      targetRoomId = latestAdminMessage.roomId;
    } else {
      // No existing conversation, use agent's primary room
      targetRoomId = runtime.agentId; // Fallback to agent's default room
    }

    // Extract message content - determine what to send based on the autonomous thought
    const autonomousThought = message.content.text || "";

    // Generate appropriate message to admin
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

    // Create and store message to admin
    const adminMessage: Memory = {
      id: asUUID(uuidv4()),
      entityId: runtime.agentId, // Agent is sending to admin
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

    // Store the message in memory
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
