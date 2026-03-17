/**
 * Send flex message action for the LINE plugin.
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
	type LineFlexMessage,
	normalizeLineTarget,
} from "../types.js";

const SEND_FLEX_TEMPLATE = `# Task: Extract LINE Flex message parameters

Based on the conversation, determine the flex message content to send.

Recent conversation:
{{recentMessages}}

Extract the following:
1. altText: Alternative text for notifications (short summary)
2. title: Card title
3. body: Card body text
4. to: The target user/group/room ID (or "current" to reply to the current chat)
5. cardType: Type of card (info, image, action, list)

Respond with a JSON object:
\`\`\`json
{
  "altText": "notification text",
  "title": "Card Title",
  "body": "Card body text",
  "to": "target ID or 'current'",
  "cardType": "info"
}
\`\`\`
`;

interface FlexMessageParams {
	altText: string;
	title: string;
	body: string;
	to: string;
	cardType: string;
}

/**
 * Create a simple info card bubble
 */
function createInfoBubble(
	title: string,
	body: string,
): { type: string; [key: string]: unknown } {
	return {
		type: "bubble",
		body: {
			type: "box",
			layout: "vertical",
			contents: [
				{
					type: "text",
					text: title,
					weight: "bold",
					size: "xl",
					wrap: true,
				},
				{
					type: "text",
					text: body,
					margin: "md",
					wrap: true,
				},
			],
		},
	};
}

export const sendFlexMessage: Action = {
	name: "LINE_SEND_FLEX_MESSAGE",
	similes: ["SEND_LINE_CARD", "LINE_FLEX", "LINE_CARD", "SEND_LINE_FLEX"],
	description: "Send a rich flex message/card via LINE",

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

		const prompt = composePromptFromState({
			template: SEND_FLEX_TEMPLATE,
			state: currentState,
		});

		let flexInfo: FlexMessageParams | null = null;

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
			});

			const parsed = parseJSONObjectFromText(response);
			if (parsed?.title && parsed?.body) {
				flexInfo = {
					altText: String(parsed.altText || `${parsed.title}: ${parsed.body}`),
					title: String(parsed.title),
					body: String(parsed.body),
					to: String(parsed.to || "current"),
					cardType: String(parsed.cardType || "info"),
				};
				break;
			}
		}

		if (!flexInfo || !flexInfo.title) {
			if (callback) {
				callback({
					text: "I couldn't understand the flex message content. Please try again.",
					source: "line",
				});
			}
			return {
				success: false,
				error: "Could not extract flex message parameters",
			};
		}

		// Determine target
		let targetId: string | undefined;

		if (flexInfo.to && flexInfo.to !== "current") {
			const normalized = normalizeLineTarget(flexInfo.to);
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
					text: "I couldn't determine where to send the message. Please specify a target.",
					source: "line",
				});
			}
			return { success: false, error: "Could not determine target" };
		}

		// Create flex message
		const flexMessage: LineFlexMessage = {
			altText: flexInfo.altText.slice(0, 400),
			contents: createInfoBubble(flexInfo.title, flexInfo.body),
		};

		// Send message
		const result = await lineService.sendFlexMessage(targetId, flexMessage);

		if (!result.success) {
			if (callback) {
				callback({
					text: `Failed to send flex message: ${result.error}`,
					source: "line",
				});
			}
			return { success: false, error: result.error };
		}

		logger.debug(`Sent LINE flex message to ${targetId}`);

		if (callback) {
			callback({
				text: "Card message sent successfully.",
				source: message.content.source as string,
			});
		}

		return {
			success: true,
			text: "Card message sent successfully",
		};
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Send them an info card with title 'Update' and body 'New features are available'",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I'll send that as a card message.",
					actions: ["LINE_SEND_FLEX_MESSAGE"],
				},
			},
		],
	],
};
