import {
  asUUID,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import type { AutonomyService } from "./service";

/**
 * Admin Chat Provider - provides conversation history with admin user
 * Only active in autonomous context to give agent memory of admin interactions
 */
export const adminChatProvider: Provider = {
  name: "ADMIN_CHAT_HISTORY",
  description:
    "Provides recent conversation history with the admin user for autonomous context",

  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    // Only provide admin chat context in autonomous room
    const autonomyService = runtime.getService<AutonomyService>("AUTONOMY");
    if (!autonomyService) {
      console.error("Autonomy service not available");
      return { text: "" }; // Service not available
    }

    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return { text: "" }; // Not in autonomous context
    }

    // Get admin user ID from settings
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return {
        text: "[ADMIN_CHAT_HISTORY]\nNo admin user configured. Set ADMIN_USER_ID in character settings.\n[/ADMIN_CHAT_HISTORY]",
        data: { adminConfigured: false },
      };
    }

    const adminUUID = asUUID(adminUserId);

    // Get recent messages from/to admin user
    const adminMessages = await runtime.getMemories({
      entityId: adminUUID,
      count: 15, // Get last 15 messages for context
      unique: false,
      tableName: "memories",
    });

    if (!adminMessages || adminMessages.length === 0) {
      return {
        text: "[ADMIN_CHAT_HISTORY]\nNo recent messages found with admin user.\n[/ADMIN_CHAT_HISTORY]",
        data: {
          adminConfigured: true,
          messageCount: 0,
          adminUserId,
        },
      };
    }

    // Format conversation history
    const conversationHistory = adminMessages
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(-10) // Take last 10 messages for context
      .map((msg) => {
        const isFromAdmin = msg.entityId === adminUUID;
        const isFromAgent = msg.entityId === runtime.agentId;

        const sender = isFromAdmin ? "Admin" : isFromAgent ? "Agent" : "Other";
        const text = msg.content.text || "[No text content]";
        const timestamp = new Date(msg.createdAt || 0).toLocaleTimeString();

        return `${timestamp} ${sender}: ${text}`;
      })
      .join("\\n");

    // Get recent admin message summary
    const recentAdminMessages = adminMessages
      .filter((msg) => msg.entityId === adminUUID)
      .slice(-3);

    const lastAdminMessage =
      recentAdminMessages[recentAdminMessages.length - 1];
    const adminMoodContext =
      recentAdminMessages.length > 0
        ? `Last admin message: "${lastAdminMessage?.content.text || "N/A"}"`
        : "No recent admin messages";

    return {
      text: `[ADMIN_CHAT_HISTORY]\nRecent conversation with admin user (${adminMessages.length} total messages):\n\n${conversationHistory}\n\n${adminMoodContext}\n[/ADMIN_CHAT_HISTORY]`,
      data: {
        adminConfigured: true,
        messageCount: adminMessages.length,
        adminUserId,
        recentMessageCount: recentAdminMessages.length,
        lastAdminMessage: lastAdminMessage?.content.text || "",
        conversationActive: adminMessages.some(
          (m) => Date.now() - (m.createdAt || 0) < 3600000,
        ), // Active within last hour
      },
    };
  },
};
