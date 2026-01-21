/**
 * Autonomy Providers for elizaOS
 *
 * Providers that supply autonomous context information.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../types";
import { stringToUuid } from "../utils";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service";

/**
 * Admin Chat Provider
 *
 * Provides conversation history with admin user for autonomous context.
 * Only active in autonomous room to give agent memory of admin interactions.
 */
export const adminChatProvider: Provider = {
  name: "ADMIN_CHAT_HISTORY",
  description:
    "Provides recent conversation history with the admin user for autonomous context",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    // Only provide admin chat context in autonomous room
    const autonomyService = runtime.getService<AutonomyService>(
      AUTONOMY_SERVICE_TYPE,
    );
    if (!autonomyService) {
      return { text: "", data: {} };
    }

    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
      return { text: "", data: {} };
    }

    // Get admin user ID
    const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
    if (!adminUserId) {
      return {
        text: "[ADMIN_CHAT_HISTORY]\nNo admin user configured. Set ADMIN_USER_ID in character settings.\n[/ADMIN_CHAT_HISTORY]",
        data: { adminConfigured: false },
      };
    }

    const adminUUID = stringToUuid(adminUserId);

    // Get recent messages from/to admin user
    const adminMessages = await runtime.getMemories({
      entityId: adminUUID,
      count: 15,
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
    const sortedMessages = adminMessages.sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    );
    const historyStart =
      sortedMessages.length > 10 ? sortedMessages.length - 10 : 0;
    const conversationHistory = sortedMessages
      .slice(historyStart)
      .map((msg) => {
        const isFromAdmin = msg.entityId === adminUUID;
        const isFromAgent = msg.entityId === runtime.agentId;

        const sender = isFromAdmin ? "Admin" : isFromAgent ? "Agent" : "Other";
        const text = msg.content.text || "[No text content]";
        const timestamp = new Date(msg.createdAt || 0).toLocaleTimeString();

        return `${timestamp} ${sender}: ${text}`;
      })
      .join("\n");

    // Get recent admin messages
    const recentAdminMessages: Memory[] = [];
    for (let i = sortedMessages.length - 1; i >= 0; i -= 1) {
      const msg = sortedMessages[i];
      if (msg.entityId !== adminUUID) continue;
      recentAdminMessages.push(msg);
      if (recentAdminMessages.length === 3) break;
    }
    recentAdminMessages.reverse();
    const lastAdminMessage =
      recentAdminMessages[recentAdminMessages.length - 1];
    const adminMoodContext =
      recentAdminMessages.length > 0
        ? `Last admin message: "${lastAdminMessage?.content.text || "N/A"}"`
        : "No recent admin messages";
    const now = Date.now();

    return {
      text: `[ADMIN_CHAT_HISTORY]\nRecent conversation with admin user (${adminMessages.length} total messages):\n\n${conversationHistory}\n\n${adminMoodContext}\n[/ADMIN_CHAT_HISTORY]`,
      data: {
        adminConfigured: true,
        messageCount: adminMessages.length,
        adminUserId,
        recentMessageCount: recentAdminMessages.length,
        lastAdminMessage: lastAdminMessage?.content.text || "",
        conversationActive: adminMessages.some(
          (m) => now - (m.createdAt || 0) < 3600000,
        ),
      },
    };
  },
};

/**
 * Autonomy Status Provider
 *
 * Shows autonomy status in regular conversations.
 * Does NOT show in autonomous room to avoid unnecessary context.
 */
export const autonomyStatusProvider: Provider = {
  name: "AUTONOMY_STATUS",
  description:
    "Provides current autonomy status for agent awareness in conversations",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    // Get autonomy service
    const autonomyService = runtime.getService<AutonomyService>(
      AUTONOMY_SERVICE_TYPE,
    );
    if (!autonomyService) {
      return { text: "", data: {} };
    }

    // Don't show in autonomous room (avoid noise)
    const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
    if (autonomousRoomId && message.roomId === autonomousRoomId) {
      return { text: "", data: {} };
    }

    // Get status
    const autonomyEnabled = runtime.enableAutonomy;
    const serviceRunning = autonomyService.isLoopRunning?.() || false;
    const interval = autonomyService.getLoopInterval?.() || 30000;

    // Determine status display
    let status: string;
    let statusIcon: string;

    if (serviceRunning) {
      status = "running autonomously";
      statusIcon = "🤖";
    } else if (autonomyEnabled) {
      status = "autonomy enabled but not running";
      statusIcon = "⏸️";
    } else {
      status = "autonomy disabled";
      statusIcon = "🔕";
    }

    const intervalSeconds = Math.round(interval / 1000);
    const intervalUnit =
      intervalSeconds < 60
        ? `${intervalSeconds} seconds`
        : `${Math.round(intervalSeconds / 60)} minutes`;

    return {
      text: `[AUTONOMY_STATUS]\nCurrent status: ${statusIcon} ${status}\nThinking interval: ${intervalUnit}\n[/AUTONOMY_STATUS]`,
      data: {
        autonomyEnabled,
        serviceRunning,
        interval,
        intervalSeconds,
        status: serviceRunning
          ? "running"
          : autonomyEnabled
            ? "enabled"
            : "disabled",
      },
    };
  },
};
