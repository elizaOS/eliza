/**
 * Send message action for BlueBubbles
 */
import {
	type Action,
	type ActionExample,
	type ActionResult,
	type Content,
	composePromptFromState,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type State,
} from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "../constants";
import type { BlueBubblesService } from "../service";

const sendMessageTemplate = `
# Task: Generate a response to send via iMessage (BlueBubbles)
{{recentMessages}}

# Instructions: Write a response to send to the user via iMessage. Be conversational and friendly.
Your response should be appropriate for iMessage - keep it relatively concise but engaging.
`;

const examples: ActionExample[][] = [
	[
		{
			name: "{{user1}}",
			content: {
				text: "Can you send a message to John saying I'll be late?",
			},
		},
		{
			name: "{{agentName}}",
			content: {
				text: "I'll send that message to John for you.",
				action: "SEND_BLUEBUBBLES_MESSAGE",
			},
		},
	],
	[
		{
			name: "{{user1}}",
			content: {
				text: "Reply to this iMessage for me",
			},
		},
		{
			name: "{{agentName}}",
			content: {
				text: "I'll compose and send a reply for you.",
				action: "SEND_BLUEBUBBLES_MESSAGE",
			},
		},
	],
];

export const sendMessageAction: Action = {
	name: "SEND_BLUEBUBBLES_MESSAGE",
	description: "Send a message via iMessage through BlueBubbles",
	descriptionCompressed: "Send iMessage via BlueBubbles.",
	similes: [
		"SEND_IMESSAGE",
		"TEXT_MESSAGE",
		"IMESSAGE_REPLY",
		"BLUEBUBBLES_SEND",
		"APPLE_MESSAGE",
	],
	examples,

	validate: async (
		runtime: any,
		message: any,
		state?: any,
		options?: any,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["send", "bluebubbles", "message"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((word) => word.length > 0 && __avText.includes(word));
		const __avRegex = /\b(?:send|bluebubbles|message)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(
			message?.content?.source ?? message?.source ?? "",
		);
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(
					__avSource ||
						state ||
						runtime?.agentId ||
						runtime?.getService ||
						runtime?.getSetting,
				);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			runtime: any,
			message: any,
			state?: any,
			options?: any,
		): Promise<boolean> => {
			const __avTextRaw =
				typeof message?.content?.text === "string" ? message.content.text : "";
			const __avText = __avTextRaw.toLowerCase();
			const __avKeywords = ["send", "bluebubbles", "message"];
			const __avKeywordOk =
				__avKeywords.length > 0 &&
				__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
			const __avRegex = /\b(?:send|bluebubbles|message)\b/i;
			const __avRegexOk = __avRegex.test(__avText);
			const __avSource = String(
				message?.content?.source ?? message?.source ?? "",
			);
			const __avExpectedSource = "bluebubbles";
			const __avSourceOk = __avExpectedSource
				? __avSource === __avExpectedSource
				: Boolean(
						__avSource || state || runtime?.agentId || runtime?.getService,
					);
			const __avOptions = options && typeof options === "object" ? options : {};
			const __avInputOk =
				__avText.trim().length > 0 ||
				Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
				Boolean(message?.content && typeof message.content === "object");

			if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
				return false;
			}

			const __avLegacyValidate = async (
				runtime: IAgentRuntime,
				_message: Memory,
			): Promise<boolean> => {
				const service = runtime.getService<BlueBubblesService>(
					BLUEBUBBLES_SERVICE_NAME,
				);
				return service?.getIsRunning() ?? false;
			};
			try {
				return Boolean(
					await (__avLegacyValidate as any)(runtime, message, state, options),
				);
			} catch {
				return false;
			}
		};
		try {
			return Boolean(
				await (__avLegacyValidate as any)(runtime, message, state, options),
			);
		} catch {
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options: Record<string, unknown> | undefined,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);
		const currentState = state ?? (await runtime.composeState(message));

		if (!service?.getIsRunning()) {
			logger.error("BlueBubbles service is not available");
			if (callback) {
				await callback({
					text: "Sorry, the iMessage service is currently unavailable.",
				});
			}
			return { success: false, error: "BlueBubbles service not available" };
		}

		try {
			// Get the room to find the target
			const room = await runtime.getRoom(message.roomId);
			if (!room?.channelId) {
				logger.error("No channel ID found for room");
				if (callback) {
					await callback({
						text: "Unable to determine the message recipient.",
					});
				}
				return { success: false, error: "No channel ID" };
			}

			// Generate response if state is available
			const prompt = composePromptFromState({
				state: currentState,
				template: sendMessageTemplate,
			});

			const response = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt,
			});

			const responseText =
				typeof response === "string"
					? response
					: ((response as { text?: string }).text ?? "");

			if (!responseText.trim()) {
				logger.warn("Generated empty response, skipping send");
				return { success: false, error: "Empty response generated" };
			}

			// Send the message
			const result = await service.sendMessage(
				room.channelId,
				responseText,
				message.content.inReplyTo as string | undefined,
			);

			logger.info(`Sent BlueBubbles message: ${result.guid}`);

			const content: Content = {
				text: responseText,
				source: "bluebubbles",
				metadata: {
					messageGuid: result.guid,
					chatGuid: room.channelId,
				},
			};

			if (callback) {
				await callback(content);
			}

			return { success: true, text: responseText };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(`Failed to send BlueBubbles message: ${errorMessage}`);

			if (callback) {
				await callback({
					text: "Failed to send the iMessage. Please try again.",
				});
			}

			return { success: false, error: errorMessage };
		}
	},
};
