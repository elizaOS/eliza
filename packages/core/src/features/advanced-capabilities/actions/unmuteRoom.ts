import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import { shouldUnmuteRoomTemplate } from "../../../prompts.ts";
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
import { ModelType } from "../../../types/index.ts";
import {
	composePromptFromState,
	parseBooleanFromText,
} from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UNMUTE_ROOM");
const UNMUTE_TERMS = getValidationKeywordTerms("action.unmuteRoom.request", {
	includeAllLocales: true,
});

export const unmuteRoomAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	examples: (spec.examples ?? []) as ActionExample[][],
	validate: async (runtime: IAgentRuntime, message: Memory) => {
		const text =
			typeof message?.content === "string"
				? message.content
				: (message?.content?.text ?? "");
		if (findKeywordTermMatch(text, UNMUTE_TERMS) === undefined) return false;
		const roomId = message.roomId;
		const roomState = await runtime.getParticipantUserState(
			roomId,
			runtime.agentId,
		);
		return roomState === "MUTED";
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		_callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		async function _shouldUnmute(state: State): Promise<boolean> {
			const shouldUnmutePrompt = composePromptFromState({
				state,
				template: shouldUnmuteRoomTemplate,
			});

			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: shouldUnmutePrompt,
				stopSequences: [],
			});

			const decisionValue = response.trim();
			const cleanedResponse = String(decisionValue).trim().toLowerCase();

			// Handle various affirmative responses
			if (
				parseBooleanFromText(decisionValue) ||
				cleanedResponse.includes("true") ||
				cleanedResponse.includes("yes")
			) {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: message.agentId,
						roomId: message.roomId,
						content: {
							source: message.content.source,
							thought:
								"I will now unmute this room and start considering it for responses again",
							actions: ["UNMUTE_ROOM_STARTED"],
						},
					},
					"messages",
				);
				return true;
			}

			// Handle various negative responses
			if (
				cleanedResponse === "false" ||
				cleanedResponse === "no" ||
				cleanedResponse === "n" ||
				cleanedResponse.includes("false") ||
				cleanedResponse.includes("no")
			) {
				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: message.agentId,
						roomId: message.roomId,
						content: {
							source: message.content.source,
							thought: "I tried to unmute a room but I decided not to",
							actions: ["UNMUTE_ROOM_FAILED"],
						},
					},
					"messages",
				);
				return false;
			}

			// Default to false if response is unclear
			logger.warn(
				{
					src: "plugin:advanced-capabilities:action:unmute_room",
					agentId: runtime.agentId,
					response,
				},
				"Unclear boolean response, defaulting to false",
			);
			return false;
		}

		if (!state) {
			return {
				text: "State is required for unmute room action",
				values: {
					success: false,
					error: "STATE_REQUIRED",
				},
				data: {
					actionName: "UNMUTE_ROOM",
					error: "State is required",
				},
				success: false,
				error: new Error("State is required for unmute room action"),
			};
		}

		const shouldUnmute = await _shouldUnmute(state);

		if (shouldUnmute) {
			try {
				await runtime.updateParticipantUserState(
					message.roomId,
					runtime.agentId,
					null,
				);

				const room = await runtime.getRoom(message.roomId);

				if (!room) {
					logger.warn(
						{
							src: "plugin:advanced-capabilities:action:unmute_room",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						"Room not found",
					);
					return {
						text: `Room not found: ${message.roomId}`,
						values: {
							success: false,
							error: "ROOM_NOT_FOUND",
							roomId: message.roomId,
						},
						data: {
							actionName: "UNMUTE_ROOM",
							error: "Room not found",
							roomId: message.roomId,
						},
						success: false,
					};
				}

				// Ensure room has a name for consistent return values
				const roomName = room.name ?? `Room-${message.roomId.substring(0, 8)}`;

				await runtime.createMemory(
					{
						entityId: message.entityId,
						agentId: message.agentId,
						roomId: message.roomId,
						content: {
							thought: `I unmuted the room ${roomName}`,
							actions: ["UNMUTE_ROOM_START"],
						},
					},
					"messages",
				);

				return {
					text: `Room unmuted: ${roomName}`,
					values: {
						success: true,
						roomUnmuted: true,
						roomId: message.roomId,
						roomName: roomName,
						newState: "NONE",
					},
					data: {
						actionName: "UNMUTE_ROOM",
						roomId: message.roomId,
						roomName: roomName,
						unmuted: true,
					},
					success: true,
				};
			} catch (error) {
				logger.error(
					{
						src: "plugin:advanced-capabilities:action:unmute_room",
						agentId: runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error unmuting room",
				);
				return {
					text: "Failed to unmute room",
					values: {
						success: false,
						error: "UNMUTE_FAILED",
					},
					data: {
						actionName: "UNMUTE_ROOM",
						error: error instanceof Error ? error.message : String(error),
						roomId: message.roomId,
					},
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		} else {
			return {
				text: "Decided not to unmute room",
				values: {
					success: true,
					roomUnmuted: false,
					roomId: message.roomId,
					reason: "CRITERIA_NOT_MET",
				},
				data: {
					actionName: "UNMUTE_ROOM",
					roomId: message.roomId,
					unmuted: false,
					reason: "Decision criteria not met",
				},
				success: true,
			};
		}
	},
};
