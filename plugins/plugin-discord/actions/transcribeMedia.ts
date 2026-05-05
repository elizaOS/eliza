import {
	type Action,
	type ActionExample,
	type ActionResult,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Media,
	type Memory,
	type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";

type MediaCandidate = Media & { _createdAt?: number };

const MEDIA_REQUEST_PATTERN =
	/\b(?:transcribe|transcript|audio|video|media|youtube|meeting|recording|podcast|call|conference|interview|speech|lecture|presentation|voice|song)\b/i;

function messageText(message: Memory): string {
	return typeof message.content.text === "string" ? message.content.text : "";
}

function isMediaAttachment(attachment: Media | null | undefined): attachment is Media {
	if (!attachment) {
		return false;
	}
	if (
		attachment.contentType === ContentType.AUDIO ||
		attachment.contentType === ContentType.VIDEO
	) {
		return true;
	}
	return /^(audio|video)$/i.test(attachment.source ?? "");
}

function attachmentLabel(attachment: Media): string {
	return attachment.title?.trim() || attachment.url || attachment.id;
}

function requestedAttachmentMatches(text: string, attachment: Media): boolean {
	const normalizedText = text.toLowerCase();
	const values = [attachment.id, attachment.title, attachment.url]
		.filter((value): value is string => Boolean(value?.trim()))
		.map((value) => value.toLowerCase());
	return values.some((value) => value.length >= 4 && normalizedText.includes(value));
}

async function collectMediaCandidates(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<{
	current: MediaCandidate[];
	all: MediaCandidate[];
}> {
	const current = ((message.content.attachments ?? []) as Media[])
		.filter(isMediaAttachment)
		.map((attachment) => ({
			...attachment,
			_createdAt: message.createdAt ?? Date.now(),
		}));
	const candidatesById = new Map<string, MediaCandidate>();
	for (const attachment of current) {
		candidatesById.set(attachment.id, attachment);
	}

	const conversationLength = runtime.getConversationLength?.() ?? 20;
	const recentMessages = await runtime.getMemories?.({
		tableName: "messages",
		roomId: message.roomId,
		count: conversationLength,
		unique: false,
	});
	if (Array.isArray(recentMessages)) {
		for (const recentMessage of recentMessages) {
			const createdAt = recentMessage.createdAt ?? 0;
			const attachments = (recentMessage.content.attachments ?? []) as Media[];
			for (const attachment of attachments.filter(isMediaAttachment)) {
				const existing = candidatesById.get(attachment.id);
				if (existing && (existing._createdAt ?? 0) >= createdAt) {
					continue;
				}
				candidatesById.set(attachment.id, { ...attachment, _createdAt: createdAt });
			}
		}
	}

	return {
		current,
		all: Array.from(candidatesById.values()).sort(
			(left, right) => (right._createdAt ?? 0) - (left._createdAt ?? 0),
		),
	};
}

async function selectMediaAttachments(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<MediaCandidate[]> {
	const { current, all } = await collectMediaCandidates(runtime, message);
	const explicitId =
		typeof message.content.attachmentId === "string"
			? message.content.attachmentId.trim()
			: typeof message.content.id === "string"
				? message.content.id.trim()
				: "";
	if (explicitId) {
		return all.filter(
			(attachment) => attachment.id.toLowerCase() === explicitId.toLowerCase(),
		);
	}
	if (current.length > 0) {
		return current;
	}
	const text = messageText(message);
	const requested = all.filter((attachment) =>
		requestedAttachmentMatches(text, attachment),
	);
	if (requested.length > 0) {
		return requested;
	}
	return all.length > 0 ? [all[0]] : [];
}

function transcriptText(attachment: Media): string {
	return typeof attachment.text === "string" ? attachment.text.trim() : "";
}

function formatTranscript(attachments: MediaCandidate[]): string {
	const transcripts = attachments
		.map((attachment, index) => ({
			label: attachmentLabel(attachment),
			index,
			text: transcriptText(attachment),
		}))
		.filter((entry) => entry.text);
	if (transcripts.length === 1) {
		return transcripts[0]?.text ?? "";
	}
	return transcripts
		.map((entry) =>
			[`Transcript ${entry.index + 1}: ${entry.label}`, entry.text].join("\n"),
		)
		.join("\n\n");
}

function mediaKind(attachments: MediaCandidate[]): "audio" | "video" | "media" {
	if (attachments.every((attachment) => attachment.contentType === ContentType.AUDIO)) {
		return "audio";
	}
	if (attachments.every((attachment) => attachment.contentType === ContentType.VIDEO)) {
		return "video";
	}
	return "media";
}

function missingTranscriptMessage(attachments: MediaCandidate[]): string {
	const kind = mediaKind(attachments);
	return attachments.length === 1
		? `I don't have a transcript for that ${kind} attachment yet.`
		: `I don't have transcripts for those ${kind} attachments yet.`;
}

/**
 * Action for transcribing the full text of an audio or video file that the user has attached.
 *
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Similes associated with the action.
 * @property {string} description - Description of the action.
 * @property {Function} validate - Validation function for the action.
 * @property {Function} handler - Handler function for the action.
 * @property {ActionExample[][]} examples - Examples demonstrating the action.
 */
const spec = requireActionSpec("TRANSCRIBE_MEDIA");

export const transcribeMedia: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	suppressPostActionContinuation: true,
	validate: async (_runtime, message): Promise<boolean> => {
		if (message.content.source !== "discord") {
			return false;
		}
		const currentAttachments = (message.content.attachments ?? []) as Media[];
		if (currentAttachments.some(isMediaAttachment)) {
			return true;
		}
		return MEDIA_REQUEST_PATTERN.test(messageText(message));
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const selectedAttachments = await selectMediaAttachments(runtime, message);
		if (selectedAttachments.length === 0) {
			const text = "I don't see an audio or video attachment to transcribe.";
			runtime.logger.warn(
				{
					src: "plugin:discord:action:transcribe-media",
					agentId: runtime.agentId,
				},
				"Could not find media attachment to transcribe",
			);
			await callback?.({
				text,
				actions: ["TRANSCRIBE_MEDIA_FAILED"],
				source: message.content.source,
			});
			return { success: false, text };
		}

		const transcript = formatTranscript(selectedAttachments);
		if (!transcript) {
			const text = missingTranscriptMessage(selectedAttachments);
			await callback?.({
				text,
				actions: ["TRANSCRIBE_MEDIA_FAILED"],
				source: message.content.source,
			});
			return { success: false, text };
		}

		if (
			transcript.split("\n").length < 4 ||
			transcript.split(/\s+/).filter(Boolean).length < 100
		) {
			const text = `Here is the transcript:
\`\`\`md
${transcript}
\`\`\`
`;
			await callback?.({
				text,
				actions: ["TRANSCRIBE_MEDIA_RESPONSE"],
				source: message.content.source,
				attachments: [],
			});
			return { success: true, text };
		}

		const transcriptFilename = `content/transcript_${Date.now()}`;
		await runtime.setCache<string>(transcriptFilename, transcript);

		const text = "I've attached the transcript as a text file.";
		await callback?.({
			text,
			actions: ["TRANSCRIBE_MEDIA_RESPONSE"],
			source: message.content.source,
			attachments: [
				{
					id: transcriptFilename,
					url: transcriptFilename,
					title: "Transcript",
					source: "discord",
					contentType: ContentType.DOCUMENT,
				} as Media,
			],
		});
		return { success: true, text };
	},
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default transcribeMedia;
