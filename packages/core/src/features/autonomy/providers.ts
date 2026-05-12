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
} from "../../types";
import { stringToUuid } from "../../utils";
import { AUTONOMY_SERVICE_TYPE, type AutonomyService } from "./service";

const MAX_ADMIN_HISTORY_MESSAGES = 10;
const MAX_ADMIN_MESSAGE_LENGTH = 280;
const MAX_AUTONOMY_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
	contexts: ["admin", "settings"],
	contextGate: { anyOf: ["admin", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "ADMIN" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		try {
			// Only provide admin chat context in autonomous room
			const autonomyService = runtime.getService<AutonomyService>(
				AUTONOMY_SERVICE_TYPE,
			);
			if (!autonomyService) {
				return {
					text: "",
					data: { available: false, reason: "autonomy_service_unavailable" },
				};
			}

			const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
			if (!autonomousRoomId || message.roomId !== autonomousRoomId) {
				return {
					text: "",
					data: { available: false, reason: "not_autonomous_room" },
				};
			}

			const adminUserId = runtime.getSetting("ADMIN_USER_ID") as string;
			if (!adminUserId) {
				return {
					text: "[ADMIN_CHAT_HISTORY]\nNo admin user configured. Set ADMIN_USER_ID in character settings.\n[/ADMIN_CHAT_HISTORY]",
					data: { adminConfigured: false, messageCount: 0 },
					values: { adminConfigured: false, adminHistoryCount: 0 },
				};
			}

			const adminUUID = stringToUuid(adminUserId);
			const adminMessages = await runtime.getMemories({
				entityId: adminUUID,
				limit: 15,
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
					values: { adminConfigured: true, adminHistoryCount: 0 },
				};
			}

			const sortedMessages = adminMessages.sort(
				(a, b) => (a.createdAt || 0) - (b.createdAt || 0),
			);
			const historyStart =
				sortedMessages.length > MAX_ADMIN_HISTORY_MESSAGES
					? sortedMessages.length - MAX_ADMIN_HISTORY_MESSAGES
					: 0;
			const historyMessages = sortedMessages.slice(historyStart);
			const conversationHistory = historyMessages
				.map((msg) => {
					const isFromAdmin = msg.entityId === adminUUID;
					const isFromAgent = msg.entityId === runtime.agentId;

					const sender = isFromAdmin
						? "Admin"
						: isFromAgent
							? "Agent"
							: "Other";
					const rawText = msg.content.text || "[No text content]";
					const text =
						rawText.length > MAX_ADMIN_MESSAGE_LENGTH
							? `${rawText.slice(0, MAX_ADMIN_MESSAGE_LENGTH)}...`
							: rawText;
					const timestamp = new Date(msg.createdAt || 0).toLocaleTimeString();

					return `${timestamp} ${sender}: ${text}`;
				})
				.join("\n");

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
			const lastAdminMessageText = lastAdminMessage?.content.text || "";
			const adminMoodContext =
				recentAdminMessages.length > 0
					? `Last admin message: "${lastAdminMessageText.slice(0, MAX_ADMIN_MESSAGE_LENGTH) || "N/A"}"`
					: "No recent admin messages";
			const now = Date.now();

			return {
				text: `[ADMIN_CHAT_HISTORY]\nRecent conversation with admin user (${adminMessages.length} total messages):\n\n${conversationHistory}\n\n${adminMoodContext}\n[/ADMIN_CHAT_HISTORY]`,
				data: {
					adminConfigured: true,
					messageCount: adminMessages.length,
					adminUserId,
					recentMessageCount: recentAdminMessages.length,
					lastAdminMessage: lastAdminMessageText.slice(
						0,
						MAX_ADMIN_MESSAGE_LENGTH,
					),
					conversationActive: adminMessages.some(
						(m) => now - (m.createdAt || 0) < 3600000,
					),
					historyWindowCount: historyMessages.length,
				},
				values: {
					adminConfigured: true,
					adminHistoryCount: adminMessages.length,
					adminHistoryWindowCount: historyMessages.length,
				},
			};
		} catch (error) {
			return {
				text: "",
				data: {
					available: false,
					reason: "admin_history_unavailable",
					error: error instanceof Error ? error.message : String(error),
				},
				values: { adminConfigured: false, adminHistoryCount: 0 },
			};
		}
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
	contexts: ["automation", "agent_internal"],
	contextGate: { anyOf: ["automation", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "ADMIN" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		try {
			const autonomyService = runtime.getService<AutonomyService>(
				AUTONOMY_SERVICE_TYPE,
			);
			if (!autonomyService) {
				return {
					text: "",
					data: { available: false, reason: "autonomy_service_unavailable" },
				};
			}

			const autonomousRoomId = autonomyService.getAutonomousRoomId?.();
			if (autonomousRoomId && message.roomId === autonomousRoomId) {
				return {
					text: "",
					data: { available: false, reason: "autonomous_room" },
				};
			}

			const autonomyEnabled = runtime.enableAutonomy;
			const serviceRunning = autonomyService.isLoopRunning?.() || false;
			const interval = Math.min(
				autonomyService.getLoopInterval?.() || 30000,
				MAX_AUTONOMY_INTERVAL_MS,
			);

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
				values: {
					autonomyEnabled,
					autonomyRunning: serviceRunning,
					autonomyIntervalSeconds: intervalSeconds,
				},
			};
		} catch (error) {
			return {
				text: "",
				data: {
					available: false,
					reason: "autonomy_status_unavailable",
					error: error instanceof Error ? error.message : String(error),
				},
				values: {
					autonomyEnabled: false,
					autonomyRunning: false,
				},
			};
		}
	},
};
