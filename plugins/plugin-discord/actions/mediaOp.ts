import {
	type Action,
	type ActionExample,
	type ActionResult,
	type Content,
	ContentType,
	composePromptFromState,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Media,
	type Memory,
	MemoryType,
	ModelType,
	type Service,
	ServiceType,
	type State,
} from "@elizaos/core";
import { mediaUrlTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { getActionParameters, parseJsonObjectFromText } from "../utils";

type DiscordMediaOp = "download" | "transcribe";

const VALID_OPS: readonly DiscordMediaOp[] = ["download", "transcribe"];

const opRouterTemplate = `Pick the Discord media operation that matches the user's request.

Recent conversation:
{{recentMessages}}

Allowed values for "op":
- download: download a media attachment or URL from Discord
- transcribe: transcribe an audio or video attachment from Discord

Respond with JSON only, no markdown:
{"op":"download"}`;

const TRANSCRIBE_REQUEST_PATTERN =
	/\b(?:transcribe|transcript|audio|video|media|youtube|meeting|recording|podcast|call|conference|interview|speech|lecture|presentation|voice|song)\b/i;

interface VideoServiceInterface extends Service {
	fetchVideoInfo: (
		url: string,
	) => Promise<{ title: string; description: string }>;
	downloadVideo: (videoInfo: {
		title: string;
		description: string;
	}) => Promise<string>;
}

type MediaCandidate = Media & { _createdAt?: number };

function messageText(message: Memory): string {
	return typeof message.content.text === "string" ? message.content.text : "";
}

function isMediaAttachment(
	attachment: Media | null | undefined,
): attachment is Media {
	if (!attachment) return false;
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
	return values.some(
		(value) => value.length >= 4 && normalizedText.includes(value),
	);
}

async function collectMediaCandidates(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<{ current: MediaCandidate[]; all: MediaCandidate[] }> {
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
				if (existing && (existing._createdAt ?? 0) >= createdAt) continue;
				candidatesById.set(attachment.id, {
					...attachment,
					_createdAt: createdAt,
				});
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
	if (current.length > 0) return current;
	const text = messageText(message);
	const requested = all.filter((attachment) =>
		requestedAttachmentMatches(text, attachment),
	);
	if (requested.length > 0) return requested;
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
	if (
		attachments.every(
			(attachment) => attachment.contentType === ContentType.AUDIO,
		)
	) {
		return "audio";
	}
	if (
		attachments.every(
			(attachment) => attachment.contentType === ContentType.VIDEO,
		)
	) {
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

function quickResolveOp(
	options: HandlerOptions | undefined,
	message: Memory,
): DiscordMediaOp | null {
	const parameters = getActionParameters(options);
	const optsOp =
		typeof parameters.op === "string" ? parameters.op.toLowerCase() : undefined;
	if (optsOp && (VALID_OPS as readonly string[]).includes(optsOp)) {
		return optsOp as DiscordMediaOp;
	}

	const text = messageText(message);
	const lower = text.toLowerCase();
	if (/\b(transcribe|transcript)\b/.test(lower)) return "transcribe";
	if (/\b(download|fetch|save)\b/.test(lower)) return "download";

	const attachments = (message.content.attachments ?? []) as Media[];
	if (attachments.some(isMediaAttachment)) return "transcribe";

	return null;
}

async function modelResolveOp(
	runtime: IAgentRuntime,
	state: State,
): Promise<DiscordMediaOp | null> {
	const prompt = composePromptFromState({ state, template: opRouterTemplate });
	for (let i = 0; i < 3; i++) {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		const op =
			typeof parsed?.op === "string" ? parsed.op.toLowerCase() : undefined;
		if (op && (VALID_OPS as readonly string[]).includes(op)) {
			return op as DiscordMediaOp;
		}
	}
	return null;
}

async function handleDownload(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	options: HandlerOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult | undefined> {
	const videoService = runtime.getService<VideoServiceInterface>(
		ServiceType.VIDEO,
	);
	if (!videoService) {
		runtime.logger.error(
			{
				src: "plugin:discord:action:media-op:download",
				agentId: runtime.agentId,
			},
			"Video service not found",
		);
		return { success: false, error: "Video service not available" };
	}

	const parameters = getActionParameters(options);
	let mediaUrl =
		typeof parameters.mediaUrl === "string" ? parameters.mediaUrl : null;
	const prompt = composePromptFromState({ state, template: mediaUrlTemplate });
	for (let i = 0; i < 5; i++) {
		if (mediaUrl) break;
		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
		const parsed = parseJsonObjectFromText(response);
		if (parsed?.mediaUrl) {
			mediaUrl = String(parsed.mediaUrl);
			break;
		}
	}
	if (!mediaUrl) {
		runtime.logger.warn(
			{
				src: "plugin:discord:action:media-op:download",
				agentId: runtime.agentId,
			},
			"Could not get media URL from messages",
		);
		await runtime.createMemory(
			{
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				content: {
					source: "discord",
					thought: "I couldn't find the media URL in the message",
					actions: ["DISCORD_MEDIA_OP_FAILED"],
				},
				metadata: { type: MemoryType.CUSTOM },
			},
			"messages",
		);
		return { success: false, error: "Could not get media URL from messages" };
	}

	const videoInfo = await videoService.fetchVideoInfo(mediaUrl);
	const mediaPath = await videoService.downloadVideo(videoInfo);
	const response: Content = {
		text: `I downloaded the video "${videoInfo.title}" and attached it below.`,
		actions: ["DISCORD_MEDIA_OP_RESPONSE"],
		source: message.content.source,
		attachments: [
			{
				id: mediaPath,
				url: mediaPath,
				title: "Downloaded Media",
				source: "discord",
				contentType: ContentType.DOCUMENT,
			} as Media,
		],
	};

	const maxRetries = 3;
	let retries = 0;
	while (retries < maxRetries) {
		try {
			await callback?.(response);
			break;
		} catch (error) {
			retries++;
			runtime.logger.error(
				{
					src: "plugin:discord:action:media-op:download",
					agentId: runtime.agentId,
					attempt: retries,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error sending message",
			);
			if (retries === maxRetries) break;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
	return { success: true, ...response };
}

async function handleTranscribe(
	runtime: IAgentRuntime,
	message: Memory,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	const selectedAttachments = await selectMediaAttachments(runtime, message);
	if (selectedAttachments.length === 0) {
		const text = "I don't see an audio or video attachment to transcribe.";
		runtime.logger.warn(
			{
				src: "plugin:discord:action:media-op:transcribe",
				agentId: runtime.agentId,
			},
			"Could not find media attachment to transcribe",
		);
		await callback?.({
			text,
			actions: ["DISCORD_MEDIA_OP_FAILED"],
			source: message.content.source,
		});
		return { success: false, text };
	}

	const transcript = formatTranscript(selectedAttachments);
	if (!transcript) {
		const text = missingTranscriptMessage(selectedAttachments);
		await callback?.({
			text,
			actions: ["DISCORD_MEDIA_OP_FAILED"],
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
			actions: ["DISCORD_MEDIA_OP_RESPONSE"],
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
		actions: ["DISCORD_MEDIA_OP_RESPONSE"],
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
}

const spec = requireActionSpec("DISCORD_MEDIA_OP");

export const mediaOp: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	suppressPostActionContinuation: true,
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
	): Promise<boolean> => {
		if (message.content.source !== "discord") return false;
		const currentAttachments = (message.content.attachments ?? []) as Media[];
		if (currentAttachments.some(isMediaAttachment)) return true;
		return TRANSCRIBE_REQUEST_PATTERN.test(messageText(message));
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		let op = quickResolveOp(options, message);
		let currentState = state;
		if (!op) {
			currentState = state ?? (await runtime.composeState(message));
			op = await modelResolveOp(runtime, currentState);
		}
		if (!op) {
			await callback?.({
				text: "I couldn't determine which Discord media operation to run.",
				source: "discord",
			});
			return { success: false, error: "Could not resolve media op" };
		}
		switch (op) {
			case "download": {
				const downloadState =
					currentState ?? (await runtime.composeState(message));
				return handleDownload(
					runtime,
					message,
					downloadState,
					options,
					callback,
				);
			}
			case "transcribe":
				return handleTranscribe(runtime, message, callback);
		}
	},
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default mediaOp;
