/**
 * BlueBubbles message operation router.
 *
 * Single planner-facing router for BlueBubbles send/react operations.
 */

import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { composePromptFromState, logger, ModelType } from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "../constants.js";
import type { BlueBubblesService } from "../service.js";

type MessageOp = "send" | "react";

interface MessageOpInfo {
	op: MessageOp;
	text?: string;
	emoji?: string;
	messageId?: string;
	remove: boolean;
}

const VALID_OPS: ReadonlySet<MessageOp> = new Set(["send", "react"]);

const messageOpTemplate = `# Task: Extract BlueBubbles (iMessage) message operation parameters

Determine which iMessage operation the user wants and extract its parameters.

Recent conversation:
{{recentMessages}}

Operations:
- send: send an iMessage reply. Provide \`text\` with the reply.
- react: add or remove a reaction. Provide \`emoji\`, \`messageId\` ("last" for the most recent message), and \`remove\` (true to remove).

Respond with JSON only. Return exactly one JSON object with this shape:
{"op":"send","text":"","emoji":null,"messageId":"last","remove":false}
`;

const sendMessageTemplate = `# Task: Generate a response to send via iMessage (BlueBubbles)
{{recentMessages}}

# Instructions: Write a response to send to the user via iMessage. Be conversational and friendly.
Your response should be appropriate for iMessage - keep it relatively concise but engaging.
`;

const examples: ActionExample[][] = [
	[
		{
			name: "{{user1}}",
			content: { text: "Reply to this iMessage for me" },
		},
		{
			name: "{{agentName}}",
			content: {
				text: "I'll send a reply via iMessage.",
				actions: ["BLUEBUBBLES_MESSAGE_OP"],
			},
		},
	],
	[
		{
			name: "{{user1}}",
			content: { text: "React to that message with a heart" },
		},
		{
			name: "{{agentName}}",
			content: {
				text: "I'll add a heart reaction.",
				actions: ["BLUEBUBBLES_MESSAGE_OP"],
			},
		},
	],
];

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string") {
		return null;
	}
	try {
		const parsed = JSON.parse(value.trim()) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function readParams(
	options?: HandlerOptions | Record<string, unknown> | unknown,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function normalizeInfo(parsed: Record<string, unknown>): MessageOpInfo | null {
	const opRaw =
		typeof parsed.op === "string" ? parsed.op.toLowerCase().trim() : "";
	if (!VALID_OPS.has(opRaw as MessageOp)) {
		return null;
	}
	return {
		op: opRaw as MessageOp,
		text:
			typeof parsed.text === "string" && parsed.text.trim().length > 0
				? parsed.text
				: undefined,
		emoji:
			typeof parsed.emoji === "string" && parsed.emoji.trim().length > 0
				? parsed.emoji
				: undefined,
		messageId:
			typeof parsed.messageId === "string" && parsed.messageId.trim().length > 0
				? parsed.messageId
				: undefined,
		remove:
			parsed.remove === true ||
			String(parsed.remove ?? "").toLowerCase() === "true",
	};
}

function parseInfo(raw: unknown): MessageOpInfo | null {
	const parsed = parseJsonObject(raw);
	return parsed ? normalizeInfo(parsed) : null;
}

async function handleSend(
	runtime: IAgentRuntime,
	service: BlueBubblesService,
	currentState: State,
	message: Memory,
	chatGuid: string,
	preExtractedText: string | undefined,
	_callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	let responseText = preExtractedText?.trim() ?? "";

	if (!responseText) {
		const prompt = composePromptFromState({
			state: currentState,
			template: sendMessageTemplate,
		});
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		responseText =
			typeof response === "string"
				? response.trim()
				: ((response as { text?: string }).text ?? "").trim();
	}

	if (!responseText) {
		logger.warn(
			"[BLUEBUBBLES_MESSAGE_OP] Generated empty response, skipping send",
		);
		return { success: false, error: "Empty response generated" };
	}

	const result = await service.sendMessage(
		chatGuid,
		responseText,
		message.content.inReplyTo as string | undefined,
	);

	logger.info(`[BLUEBUBBLES_MESSAGE_OP] Sent iMessage: ${result.guid}`);

	return {
		success: true,
		data: {
			op: "send",
			messageGuid: result.guid,
			chatGuid,
			suppressVisibleCallback: true,
			suppressActionResultClipboard: true,
		},
	};
}

async function handleReact(
	service: BlueBubblesService,
	currentState: State,
	chatGuid: string,
	info: MessageOpInfo,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	if (!info.emoji) {
		if (callback) {
			await callback({
				text: "I couldn't understand the reaction. Please specify an emoji.",
				source: "bluebubbles",
			});
		}
		return { success: false, error: "Missing emoji for react" };
	}

	const stateData = (currentState.data ?? {}) as Record<string, unknown>;
	let messageGuid = info.messageId;
	if (!messageGuid || messageGuid === "last") {
		messageGuid =
			typeof stateData.lastMessageGuid === "string"
				? stateData.lastMessageGuid
				: undefined;
	}

	if (!messageGuid) {
		if (callback) {
			await callback({
				text: "I couldn't find the message to react to.",
				source: "bluebubbles",
			});
		}
		return { success: false, error: "Could not find message to react to" };
	}

	const reactionValue = info.remove ? `-${info.emoji}` : info.emoji;
	const result = await service.sendReaction(
		chatGuid,
		messageGuid,
		reactionValue,
	);

	if (!result.success) {
		if (callback) {
			await callback({
				text: `Failed to ${info.remove ? "remove" : "add"} reaction.`,
				source: "bluebubbles",
			});
		}
		return { success: false, error: "Failed to send reaction" };
	}

	logger.debug(
		`[BLUEBUBBLES_MESSAGE_OP] ${info.remove ? "Removed" : "Added"} reaction ${info.emoji} on ${messageGuid}`,
	);

	return {
		success: true,
		data: {
			op: "react",
			emoji: info.emoji,
			messageGuid,
			chatGuid,
			remove: info.remove,
			suppressVisibleCallback: true,
			suppressActionResultClipboard: true,
		},
	};
}

export const bluebubblesMessageOp: Action = {
	name: "BLUEBUBBLES_MESSAGE_OP",
	similes: [
		"SEND_IMESSAGE",
		"TEXT_MESSAGE",
		"IMESSAGE_REPLY",
		"BLUEBUBBLES_SEND",
		"APPLE_MESSAGE",
		"BLUEBUBBLES_REACT",
		"BB_REACTION",
		"IMESSAGE_REACT",
	],
	description:
		"BlueBubbles iMessage operation router. Send a reply or react to a message by setting op (send | react).",
	descriptionCompressed: "Bluebubbles message ops: send, react.",
	suppressPostActionContinuation: true,
	examples,

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (!message || typeof message.content !== "object" || !message.content) {
			return false;
		}
		return message.content.source === "bluebubbles";
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		_options: HandlerOptions | Record<string, unknown> | undefined,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = runtime.getService<BlueBubblesService>(
			BLUEBUBBLES_SERVICE_NAME,
		);
		const currentState = state ?? (await runtime.composeState(message));

		if (!service?.isConnected()) {
			logger.error(
				"[BLUEBUBBLES_MESSAGE_OP] BlueBubbles service is not available",
			);
			if (callback) {
				await callback({
					text: "Sorry, the iMessage service is currently unavailable.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "BlueBubbles service not available" };
		}

		const room = await runtime.getRoom(message.roomId);
		const stateData = (currentState.data ?? {}) as Record<string, unknown>;
		const chatGuid =
			room?.channelId ??
			(typeof stateData.chatGuid === "string" ? stateData.chatGuid : undefined);

		if (!chatGuid) {
			logger.error("[BLUEBUBBLES_MESSAGE_OP] No chat GUID found for room");
			if (callback) {
				await callback({
					text: "Unable to determine the message recipient.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "No chat GUID" };
		}

		const prompt = composePromptFromState({
			state: currentState,
			template: messageOpTemplate,
		});

		let info: MessageOpInfo | null = normalizeInfo(readParams(_options));
		for (let attempt = 0; attempt < 3; attempt++) {
			if (info) {
				break;
			}
			const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
			info = parseInfo(response);
			if (info) {
				break;
			}
		}

		if (!info) {
			logger.debug("[BLUEBUBBLES_MESSAGE_OP] Could not extract operation info");
			if (callback) {
				await callback({
					text: "I couldn't determine which iMessage operation to perform.",
					source: "bluebubbles",
				});
			}
			return { success: false, error: "Could not extract op parameters" };
		}

		switch (info.op) {
			case "send":
				return handleSend(
					runtime,
					service,
					currentState,
					message,
					chatGuid,
					info.text,
					callback,
				);
			case "react":
				return handleReact(service, currentState, chatGuid, info, callback);
		}
	},
};
