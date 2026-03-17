/**
 * Send location action for the LINE plugin.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import {
	composePromptFromState,
	logger,
	ModelType,
	parseJSONObjectFromText,
} from "@elizaos/core";
import type { LineService } from "../service.js";
import {
	isValidLineId,
	LINE_SERVICE_NAME,
	type LineLocationMessage,
	normalizeLineTarget,
} from "../types.js";

const SEND_LOCATION_TEMPLATE = `# Task: Extract LINE location message parameters

Based on the conversation, determine the location to send.

Recent conversation:
{{recentMessages}}

Extract the following:
1. title: Place name
2. address: Full address
3. latitude: Latitude coordinate (number)
4. longitude: Longitude coordinate (number)
5. to: The target user/group/room ID (or "current" to reply to the current chat)

Respond with a JSON object:
\`\`\`json
{
  "title": "Place Name",
  "address": "123 Main St, City",
  "latitude": 35.6762,
  "longitude": 139.6503,
  "to": "target ID or 'current'"
}
\`\`\`
`;

interface LocationParams {
	title: string;
	address: string;
	latitude: number;
	longitude: number;
	to: string;
}

export const sendLocation: Action = {
	name: "LINE_SEND_LOCATION",
	similes: [
		"SEND_LINE_LOCATION",
		"LINE_LOCATION",
		"LINE_MAP",
		"SHARE_LOCATION_LINE",
	],
	description: "Send a location message via LINE",

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		return message.content.source === "line";
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const lineService = runtime.getService(LINE_SERVICE_NAME) as unknown as
			| LineService
			| undefined;

		if (!lineService || !lineService.isConnected()) {
			if (callback) {
				callback({ text: "LINE service is not available.", source: "line" });
			}
			return { success: false, error: "LINE service not available" };
		}

		const currentState = state ?? (await runtime.composeState(message));

		// Extract parameters using LLM
		const prompt = composePromptFromState({
			template: SEND_LOCATION_TEMPLATE,
			state: currentState,
		});

		let locationInfo: LocationParams | null = null;

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
			});

			const parsed = parseJSONObjectFromText(response);
			if (
				parsed?.title &&
				parsed?.address &&
				typeof parsed?.latitude === "number" &&
				typeof parsed?.longitude === "number"
			) {
				locationInfo = {
					title: String(parsed.title),
					address: String(parsed.address),
					latitude: Number(parsed.latitude),
					longitude: Number(parsed.longitude),
					to: String(parsed.to || "current"),
				};
				break;
			}
		}

		if (!locationInfo) {
			if (callback) {
				callback({
					text: "I couldn't understand the location information. Please provide title, address, and coordinates.",
					source: "line",
				});
			}
			return { success: false, error: "Could not extract location parameters" };
		}

		// Determine target
		let targetId: string | undefined;

		if (locationInfo.to && locationInfo.to !== "current") {
			const normalized = normalizeLineTarget(locationInfo.to);
			if (normalized && isValidLineId(normalized)) {
				targetId = normalized;
			}
		}

		// Fall back to current chat
		if (!targetId) {
			const stateData = (currentState.data || {}) as Record<string, unknown>;
			targetId =
				(stateData.groupId as string) ||
				(stateData.roomId as string) ||
				(stateData.userId as string);
		}

		if (!targetId) {
			if (callback) {
				callback({
					text: "I couldn't determine where to send the location. Please specify a target.",
					source: "line",
				});
			}
			return { success: false, error: "Could not determine target" };
		}

		// Create location message
		const location: LineLocationMessage = {
			type: "location",
			title: locationInfo.title,
			address: locationInfo.address,
			latitude: locationInfo.latitude,
			longitude: locationInfo.longitude,
		};

		// Send message
		const result = await lineService.sendLocationMessage(targetId, location);

		if (!result.success) {
			if (callback) {
				callback({
					text: `Failed to send location: ${result.error}`,
					source: "line",
				});
			}
			return { success: false, error: result.error };
		}

		logger.debug(`Sent LINE location to ${targetId}`);

		if (callback) {
			callback({
				text: "Location sent successfully.",
				source: message.content.source as string,
			});
		}

		return {
			success: true,
			text: "Location sent successfully",
		};
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Send them the location of Tokyo Tower",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I'll send the location.",
					actions: ["LINE_SEND_LOCATION"],
				},
			},
		],
	],
};
