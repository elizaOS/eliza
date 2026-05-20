import {
	ChannelType as DiscordChannelType,
	type Message as DiscordMessage,
	type TextChannel,
	type ThreadChannel,
} from "discord.js";

export type ChatType = "dm" | "channel" | "thread" | "forum";

export interface EnvelopeResult {
	formattedContent: string;
	chatType: ChatType;
}

export interface DiscordReplyContext {
	messageId: string;
	authorId?: string;
	authorName: string;
	content: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ENVELOPE_REPLY_MAX_CHARS = 200;
const STORED_REPLY_MAX_CHARS = 1500;
const REPLY_REFERENCE_START = "[platform_reply_reference]";
const REPLY_REFERENCE_END = "[/platform_reply_reference]";

function formatTimestamp(timestamp: number | Date): string {
	const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
	const weekday = WEEKDAYS[date.getDay()];
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const year = date.getFullYear();
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");

	let timezone = "UTC";
	try {
		timezone =
			date
				.toLocaleTimeString("en-US", { timeZoneName: "short" })
				.split(" ")
				.pop() ?? "UTC";
	} catch {
		// Fall back to UTC.
	}

	return `${weekday} ${month}/${day}/${year} ${hours}:${minutes} ${timezone}`;
}

function detectChatType(message: DiscordMessage): ChatType {
	const channelType = message.channel.type;
	if (
		channelType === DiscordChannelType.DM ||
		channelType === DiscordChannelType.GroupDM
	) {
		return "dm";
	}

	if (
		channelType === DiscordChannelType.PublicThread ||
		channelType === DiscordChannelType.PrivateThread ||
		channelType === DiscordChannelType.AnnouncementThread
	) {
		const thread = message.channel as ThreadChannel;
		if (thread.parent?.type === DiscordChannelType.GuildForum) {
			return "forum";
		}
		return "thread";
	}

	return "channel";
}

function getSenderName(message: DiscordMessage): string {
	if (message.member?.nickname) {
		return message.member.nickname;
	}
	if (message.author.globalName) {
		return message.author.globalName;
	}
	return message.author.displayName ?? message.author.username;
}

function buildChannelLabel(
	message: DiscordMessage,
	chatType: ChatType,
): string {
	if (chatType === "dm") {
		return "DM";
	}

	const guildName = message.guild?.name;
	let channelPart: string;
	if (chatType === "thread" || chatType === "forum") {
		const thread = message.channel as ThreadChannel;
		channelPart = `#${thread.parent?.name ?? "unknown"} › ${thread.name ?? "thread"}`;
	} else {
		const channel = message.channel as TextChannel;
		channelPart = `#${channel.name ?? message.channel.id}`;
	}

	return guildName ? `${channelPart} | ${guildName}` : channelPart;
}

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}...`;
}

function sanitizeReplyReferenceText(text: string): string {
	return text
		.replaceAll(REPLY_REFERENCE_START, "[platform_reply_reference escaped]")
		.replaceAll(REPLY_REFERENCE_END, "[/platform_reply_reference escaped]");
}

function formatReplyReferenceBlock(replyContext: DiscordReplyContext): string {
	const lines = [
		REPLY_REFERENCE_START,
		`author: ${sanitizeReplyReferenceText(replyContext.authorName)}`,
		...(replyContext.authorId ? [`author_id: ${replyContext.authorId}`] : []),
		`message_id: ${replyContext.messageId}`,
		"text:",
		sanitizeReplyReferenceText(replyContext.content),
		REPLY_REFERENCE_END,
	];
	return lines.join("\n");
}

export async function getDiscordReplyContext(
	message: DiscordMessage,
): Promise<DiscordReplyContext | null> {
	const messageId = message.reference?.messageId;
	if (!messageId) return null;

	try {
		const refMessage = await message.fetchReference();
		const authorName =
			refMessage.author?.displayName ??
			refMessage.author?.username ??
			"unknown";
		const content = truncateText(
			refMessage.content ?? "",
			STORED_REPLY_MAX_CHARS,
		);
		return {
			messageId,
			authorId: refMessage.author?.id,
			authorName,
			content,
		};
	} catch {
		// Reply context is best-effort only. The Discord event can still be
		// processed without it when the referenced message was deleted or
		// unavailable to this bot.
		return null;
	}
}

export async function formatInboundEnvelope(
	message: DiscordMessage,
	rawContent: string,
	knownReplyContext?: DiscordReplyContext | null,
): Promise<EnvelopeResult> {
	const chatType = detectChatType(message);
	const channelLabel = buildChannelLabel(message, chatType);
	const senderName = getSenderName(message);
	const timestamp = formatTimestamp(message.createdTimestamp ?? Date.now());

	let replyContextText = "";
	const refContext =
		knownReplyContext ?? (await getDiscordReplyContext(message));
	if (refContext) {
		const truncated = truncateText(
			refContext.content,
			ENVELOPE_REPLY_MAX_CHARS,
		);
		// Put the reply quote AFTER the user's actual message so Stage 1
		// classification weights the user's current intent first. The previous
		// order ("replying to @x:\n> <quote>\n<userText>") biased the
		// classifier toward the quoted topic, which broke routing for turns
		// where the user replied to a long bot message and asked for something
		// unrelated (e.g. an app build after a tech-debt status update).
		// Use typographic curly quotes as outer delimiters so embedded straight
		// `"` characters in the quoted content don't visually break the wrapper
		// or confuse an LLM classifier reading the result.
		const humanReplyContext = truncated
			? `(in reply to @${refContext.authorName}: “${truncated}”)`
			: `(in reply to @${refContext.authorName})`;
		replyContextText = `\n${formatReplyReferenceBlock(refContext)}\n${humanReplyContext}`;
	}

	const header = `[Discord ${channelLabel}] @${senderName} (${timestamp})`;
	return {
		formattedContent: `${header}: ${rawContent}${replyContextText}`,
		chatType,
	};
}
