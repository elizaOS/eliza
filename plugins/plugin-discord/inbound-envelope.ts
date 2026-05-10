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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

export async function formatInboundEnvelope(
	message: DiscordMessage,
	rawContent: string,
): Promise<EnvelopeResult> {
	const chatType = detectChatType(message);
	const channelLabel = buildChannelLabel(message, chatType);
	const senderName = getSenderName(message);
	const timestamp = formatTimestamp(message.createdTimestamp ?? Date.now());

	let replyContext = "";
	if (message.reference?.messageId) {
		try {
			const refMessage = await message.fetchReference();
			const refAuthor =
				refMessage.author?.displayName ??
				refMessage.author?.username ??
				"unknown";
			const refContent = refMessage.content ?? "";
			const truncated =
				refContent.length > 200 ? `${refContent.slice(0, 200)}...` : refContent;
			// Put the reply quote AFTER the user's actual message so Stage 1
			// classification weights the user's current intent first. The previous
			// order ("replying to @x:\n> <quote>\n<userText>") biased the
			// classifier toward the quoted topic, which broke routing for turns
			// where the user replied to a long bot message and asked for something
			// unrelated (e.g. an app build after a tech-debt status update).
			// Use typographic curly quotes as outer delimiters so embedded straight
			// `"` characters in the quoted content don't visually break the wrapper
			// or confuse an LLM classifier reading the result.
			replyContext = truncated
				? `\n(in reply to @${refAuthor}: “${truncated}”)`
				: `\n(in reply to @${refAuthor})`;
		} catch {
			// Reply context is best-effort only.
		}
	}

	const header = `[Discord ${channelLabel}] @${senderName} (${timestamp})`;
	return {
		formattedContent: `${header}: ${rawContent}${replyContext}`,
		chatType,
	};
}
