/**
 * Reset Session Action
 *
 * Resets the conversation session by setting a compaction point.
 * Messages before the compaction point will not be loaded in future context.
 *
 * Only OWNER or ADMIN roles can execute this action.
 */

import { logger } from "../../../logger.ts";
import { getUserServerRole } from "../../../roles.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

export const resetSessionAction: Action = {
	name: "RESET_SESSION",
	contexts: ["memory", "agent_internal", "settings"],
	roleGate: { minRole: "ADMIN" },
	similes: ["CLEAR_HISTORY", "NEW_SESSION", "FORGET", "START_OVER", "RESET"],
	description:
		"Resets the conversation session by creating a compaction point. Messages before this point will not be included in future context. Use when the user wants to start fresh or clear conversation history.",
	suppressPostActionContinuation: true,
	parameters: [],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		if (!state) {
			return false;
		}
		if (
			!hasActionContextOrKeyword(message, state, {
				contexts: ["memory", "agent_internal", "settings"],
				keywords: [
					"reset session",
					"clear history",
					"new session",
					"start over",
					"forget this conversation",
				],
			})
		) {
			return false;
		}

		const room = state.data.room ?? (await runtime.getRoom(message.roomId));
		if (!room?.worldId) {
			// Allow in DMs without world/server context
			return Boolean(message.roomId);
		}

		// Check user has permission
		const userRole = await getUserServerRole(
			runtime,
			message.entityId,
			room.worldId,
		);

		return userRole === "OWNER" || userRole === "ADMIN";
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		try {
			const room = state?.data.room ?? (await runtime.getRoom(message.roomId));

			if (!room) {
				logger.error(
					{ src: "action:reset-session", roomId: message.roomId },
					"Room not found",
				);
				if (callback) {
					await callback({
						text: "Unable to reset session - room not found.",
						actions: ["RESET_SESSION_FAILED"],
						source: message.content.source,
					});
				}
				return {
					text: "Room not found",
					success: false,
					values: { error: "room_not_found" },
					data: { actionName: "RESET_SESSION" },
				};
			}

			const now = Date.now();
			const previousCompaction = room.metadata?.lastCompactionAt;

			// Update room metadata with compaction point
			await runtime.updateRoom({
				...room,
				metadata: {
					...room.metadata,
					lastCompactionAt: now,
					compactionHistory: [
						...(Array.isArray(room.metadata?.compactionHistory)
							? room.metadata.compactionHistory
							: []),
						{
							timestamp: now,
							triggeredBy: message.entityId,
							reason: "manual_reset",
						},
					].slice(-10), // Keep last 10 compaction events
				},
			});

			logger.info(
				{
					src: "action:reset-session",
					roomId: message.roomId,
					entityId: message.entityId,
					compactionAt: now,
				},
				"Session reset - compaction point set",
			);

			if (callback) {
				await callback({
					text: "Session has been reset. I'll start fresh from here.",
					actions: ["RESET_SESSION"],
					source: message.content.source,
				});
			}

			return {
				text: "Session reset successfully",
				success: true,
				values: {
					success: true,
					compactionAt: now,
					previousCompactionAt: previousCompaction,
					roomId: room.id,
				},
				data: {
					actionName: "RESET_SESSION",
					compactionAt: now,
					roomId: room.id,
				},
			};
		} catch (error) {
			logger.error(
				{ src: "action:reset-session", error },
				"Error resetting session",
			);

			if (callback) {
				await callback({
					text: "Sorry, I encountered an error while trying to reset the session.",
					actions: ["RESET_SESSION_FAILED"],
					source: message.content.source,
				});
			}

			return {
				text: `Error resetting session: ${error instanceof Error ? error.message : "Unknown error"}`,
				success: false,
				values: { error: String(error) },
				data: { actionName: "RESET_SESSION" },
			};
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Let's start over. Reset the session.",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Session has been reset. I'll start fresh from here.",
					actions: ["RESET_SESSION"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Clear our conversation history",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Session has been reset. I'll start fresh from here.",
					actions: ["RESET_SESSION"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Forget everything we talked about",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Session has been reset. I'll start fresh from here.",
					actions: ["RESET_SESSION"],
				},
			},
		],
	] as ActionExample[][],
};
