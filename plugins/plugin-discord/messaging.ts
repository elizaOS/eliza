import type { Guild, MessageReaction } from "discord.js";

/**
 * Options for chunking Discord text
 */
export interface ChunkDiscordTextOpts {
	/** Max characters per Discord message. Default: 2000. */
	maxChars?: number;
	/**
	 * Soft max line count per message. Default: 17.
	 * Discord clients can clip/collapse very tall messages in the UI.
	 */
	maxLines?: number;
	/** Chunking mode: "length" (default) or "newline" */
	chunkMode?: "length" | "newline";
}

interface OpenFence {
	indent: string;
	markerChar: string;
	markerLen: number;
	openLine: string;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
	const match = line.match(FENCE_RE);
	if (!match) {
		return null;
	}
	const indent = match[1] ?? "";
	const marker = match[2] ?? "";
	return {
		indent,
		markerChar: marker[0] ?? "`",
		markerLen: marker.length,
		openLine: line,
	};
}

function closeFenceLine(openFence: OpenFence): string {
	return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null): string {
	if (!openFence) {
		return text;
	}
	const closeLine = closeFenceLine(openFence);
	if (!text) {
		return closeLine;
	}
	if (!text.endsWith("\n")) {
		return `${text}\n${closeLine}`;
	}
	return `${text}${closeLine}`;
}

function splitLongLine(
	line: string,
	maxChars: number,
	opts: { preserveWhitespace: boolean },
): string[] {
	const limit = Math.max(1, Math.floor(maxChars));
	if (line.length <= limit) {
		return [line];
	}

	const out: string[] = [];
	let remaining = line;

	while (remaining.length > limit) {
		if (opts.preserveWhitespace) {
			out.push(remaining.slice(0, limit));
			remaining = remaining.slice(limit);
			continue;
		}

		const window = remaining.slice(0, limit);
		let breakIdx = -1;
		for (let i = window.length - 1; i >= 0; i--) {
			if (/\s/.test(window[i])) {
				breakIdx = i;
				break;
			}
		}

		if (breakIdx <= 0) {
			breakIdx = limit;
		}

		out.push(remaining.slice(0, breakIdx));
		remaining = remaining.slice(breakIdx);
	}

	if (remaining.length) {
		out.push(remaining);
	}

	return out;
}

function isReasoningItalicsPayload(source: string): boolean {
	return source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_");
}

/**
 * Keep italics intact for reasoning payloads wrapped with `_…_`.
 * When Discord chunking splits the message, we close italics at the end of
 * each chunk and reopen at the start of the next so every chunk renders
 * consistently.
 */
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
	if (chunks.length <= 1) {
		return chunks;
	}

	if (!isReasoningItalicsPayload(source)) {
		return chunks;
	}

	const adjusted = [...chunks];
	for (let i = 0; i < adjusted.length; i++) {
		const isLast = i === adjusted.length - 1;
		const current = adjusted[i];

		// Ensure current chunk closes italics so Discord renders it italicized
		const needsClosing = !current.trimEnd().endsWith("_");
		if (needsClosing) {
			adjusted[i] = `${current}_`;
		}

		if (isLast) {
			break;
		}

		// Re-open italics on the next chunk if needed
		const next = adjusted[i + 1];
		const leadingWhitespaceLen = next.length - next.trimStart().length;
		const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
		const nextBody = next.slice(leadingWhitespaceLen);
		if (!nextBody.startsWith("_")) {
			adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
		}
	}

	return adjusted;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(
	text: string,
	opts: ChunkDiscordTextOpts = {},
): string[] {
	const requestedMaxChars = Math.max(
		1,
		Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS),
	);
	const maxLines = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));

	const body = text ?? "";
	if (!body) {
		return [];
	}

	const maxChars = isReasoningItalicsPayload(body)
		? Math.max(1, requestedMaxChars - 2)
		: requestedMaxChars;

	const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
	if (alreadyOk) {
		return [body];
	}

	const lines = body.split("\n");
	const chunks: string[] = [];

	let current = "";
	let currentLines = 0;
	let openFence: OpenFence | null = null;

	const flush = () => {
		if (!current) {
			return;
		}
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) {
			chunks.push(payload);
		}
		current = "";
		currentLines = 0;
		if (openFence) {
			current = openFence.openLine;
			currentLines = 1;
		}
	};

	for (const originalLine of lines) {
		const fenceInfo = parseFenceLine(originalLine);
		const wasInsideFence = openFence !== null;
		let nextOpenFence: OpenFence | null = openFence;

		if (fenceInfo) {
			if (!openFence) {
				nextOpenFence = fenceInfo;
			} else if (
				openFence.markerChar === fenceInfo.markerChar &&
				fenceInfo.markerLen >= openFence.markerLen
			) {
				nextOpenFence = null;
			}
		}

		const reserveChars = nextOpenFence
			? closeFenceLine(nextOpenFence).length + 1
			: 0;
		const reserveLines = nextOpenFence ? 1 : 0;
		const effectiveMaxChars = maxChars - reserveChars;
		const effectiveMaxLines = maxLines - reserveLines;
		const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
		const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
		const prefixLen = current.length > 0 ? current.length + 1 : 0;
		const segmentLimit = Math.max(1, charLimit - prefixLen);
		const segments = splitLongLine(originalLine, segmentLimit, {
			preserveWhitespace: wasInsideFence,
		});

		for (let segIndex = 0; segIndex < segments.length; segIndex++) {
			const segment = segments[segIndex];
			const isLineContinuation = segIndex > 0;
			const delimiter = isLineContinuation
				? ""
				: current.length > 0
					? "\n"
					: "";
			const addition = `${delimiter}${segment}`;
			const nextLen = current.length + addition.length;
			const nextLines = currentLines + (isLineContinuation ? 0 : 1);

			const wouldExceedChars = nextLen > charLimit;
			const wouldExceedLines = nextLines > lineLimit;

			if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
				flush();
			}

			if (current.length > 0) {
				current += addition;
				if (!isLineContinuation) {
					currentLines += 1;
				}
			} else {
				current = segment;
				currentLines = 1;
			}
		}

		openFence = nextOpenFence;
	}

	if (current.length) {
		const payload = closeFenceIfNeeded(current, openFence);
		if (payload.trim().length) {
			chunks.push(payload);
		}
	}

	return rebalanceReasoningItalics(text, chunks);
}

/**
 * Chunks text by newlines first, then by character/line limits
 */
function chunkMarkdownTextByNewline(text: string, maxChars: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current = "";

	for (const line of lines) {
		if (current.length + line.length + 1 > maxChars && current.length > 0) {
			chunks.push(current);
			current = line;
		} else {
			current = current.length > 0 ? `${current}\n${line}` : line;
		}
	}

	if (current.length > 0) {
		chunks.push(current);
	}

	return chunks;
}

/**
 * Chunks Discord text with configurable chunking mode
 */
export function chunkDiscordTextWithMode(
	text: string,
	opts: ChunkDiscordTextOpts = {},
): string[] {
	const chunkMode = opts.chunkMode ?? "length";

	if (chunkMode !== "newline") {
		return chunkDiscordText(text, opts);
	}

	const lineChunks = chunkMarkdownTextByNewline(
		text,
		Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)),
	);

	const chunks: string[] = [];
	for (const line of lineChunks) {
		const nested = chunkDiscordText(line, opts);
		if (!nested.length && line) {
			chunks.push(line);
			continue;
		}
		chunks.push(...nested);
	}

	return chunks;
}

/**
 * Resolves the system location string for logging/display
 */
export function resolveDiscordSystemLocation(params: {
	isDirectMessage: boolean;
	isGroupDm: boolean;
	guild?: Guild | null;
	channelName: string;
}): string {
	const { isDirectMessage, isGroupDm, guild, channelName } = params;

	if (isDirectMessage) {
		return "DM";
	}

	if (isGroupDm) {
		return `Group DM #${channelName}`;
	}

	return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}

/**
 * Formats a Discord reaction emoji for display
 */
export function formatDiscordReactionEmoji(emoji: {
	id?: string | null;
	name?: string | null;
}): string {
	if (emoji.id && emoji.name) {
		return `${emoji.name}:${emoji.id}`;
	}
	return emoji.name ?? "emoji";
}

/**
 * Formats a Discord reaction emoji from a MessageReaction
 */
export function formatMessageReactionEmoji(reaction: MessageReaction): string {
	const emoji = reaction.emoji;
	if (emoji.id && emoji.name) {
		return `<:${emoji.name}:${emoji.id}>`;
	}
	return emoji.name ?? "emoji";
}

/**
 * Formats a Discord user mention
 */
export function formatDiscordUserMention(userId: string): string {
	return `<@${userId}>`;
}

/**
 * Formats a Discord channel mention
 */
export function formatDiscordChannelMention(channelId: string): string {
	return `<#${channelId}>`;
}

/**
 * Formats a Discord role mention
 */
export function formatDiscordRoleMention(roleId: string): string {
	return `<@&${roleId}>`;
}

/**
 * Extracts user ID from a mention string
 */
export function extractUserIdFromMention(mention: string): string | null {
	const match = mention.match(/^<@!?(\d+)>$/);
	return match ? match[1] : null;
}

/**
 * Extracts channel ID from a mention string
 */
export function extractChannelIdFromMention(mention: string): string | null {
	const match = mention.match(/^<#(\d+)>$/);
	return match ? match[1] : null;
}

/**
 * Extracts role ID from a mention string
 */
export function extractRoleIdFromMention(mention: string): string | null {
	const match = mention.match(/^<@&(\d+)>$/);
	return match ? match[1] : null;
}

/**
 * Resolves a timestamp string to milliseconds
 */
export function resolveTimestampMs(
	timestamp?: string | null,
): number | undefined {
	if (!timestamp) {
		return undefined;
	}
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Formats a timestamp for Discord (Discord timestamp format)
 */
export function formatDiscordTimestamp(
	timestamp: Date | number,
	format: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "f",
): string {
	const unix = Math.floor(
		(typeof timestamp === "number" ? timestamp : timestamp.getTime()) / 1000,
	);
	return `<t:${unix}:${format}>`;
}

/**
 * Strips Discord formatting from text
 */
export function stripDiscordFormatting(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "$1") // Bold
		.replace(/\*(.+?)\*/g, "$1") // Italic
		.replace(/__(.+?)__/g, "$1") // Underline
		.replace(/~~(.+?)~~/g, "$1") // Strikethrough
		.replace(/`{3}[\s\S]*?`{3}/g, "") // Code blocks
		.replace(/`(.+?)`/g, "$1") // Inline code
		.replace(/\|\|(.+?)\|\|/g, "$1") // Spoilers
		.replace(/<@!?\d+>/g, "") // User mentions
		.replace(/<#\d+>/g, "") // Channel mentions
		.replace(/<@&\d+>/g, "") // Role mentions
		.replace(/<a?:\w+:\d+>/g, "") // Custom emojis
		.trim();
}

/**
 * Escapes special Discord markdown characters
 */
export function escapeDiscordMarkdown(text: string): string {
	return text.replace(/([*_`~|\\])/g, "\\$1");
}

/**
 * Truncates text to a maximum length with an ellipsis
 */
export function truncateText(
	text: string,
	maxLength: number,
	ellipsis = "…",
): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Truncates text at a UTF-16 boundary safely
 */
export function truncateUtf16Safe(
	text: string,
	maxLength: number,
	ellipsis = "…",
): string {
	if (text.length <= maxLength) {
		return text;
	}

	const targetLength = maxLength - ellipsis.length;
	if (targetLength <= 0) {
		return ellipsis.slice(0, maxLength);
	}

	// Check if we're in the middle of a surrogate pair
	let truncateAt = targetLength;
	const charAtTruncate = text.charCodeAt(truncateAt);

	// If we're at a low surrogate, back up one
	if (charAtTruncate >= 0xdc00 && charAtTruncate <= 0xdfff) {
		truncateAt--;
	}

	return text.slice(0, truncateAt) + ellipsis;
}

/**
 * Checks if a message mentions a specific user
 */
export function messageContainsMention(text: string, userId: string): boolean {
	const mentionPattern = new RegExp(`<@!?${userId}>`);
	return mentionPattern.test(text);
}

/**
 * Extracts all user mentions from a message
 */
export function extractAllUserMentions(text: string): string[] {
	const matches = text.matchAll(/<@!?(\d+)>/g);
	return Array.from(matches, (m) => m[1]);
}

/**
 * Extracts all channel mentions from a message
 */
export function extractAllChannelMentions(text: string): string[] {
	const matches = text.matchAll(/<#(\d+)>/g);
	return Array.from(matches, (m) => m[1]);
}

/**
 * Extracts all role mentions from a message
 */
export function extractAllRoleMentions(text: string): string[] {
	const matches = text.matchAll(/<@&(\d+)>/g);
	return Array.from(matches, (m) => m[1]);
}

/**
 * Sanitizes a thread name for Discord (max 100 chars, no invalid chars)
 */
export function sanitizeThreadName(name: string): string {
	const sanitized = name
		.replace(/[\n\r]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	return truncateUtf16Safe(sanitized, 100, "");
}

/**
 * Builds a message link URL
 */
export function buildMessageLink(
	guildId: string,
	channelId: string,
	messageId: string,
): string {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * Builds a channel link URL
 */
export function buildChannelLink(guildId: string, channelId: string): string {
	return `https://discord.com/channels/${guildId}/${channelId}`;
}

/**
 * Parses a Discord message link URL
 */
export function parseMessageLink(
	url: string,
): { guildId: string; channelId: string; messageId: string } | null {
	const match = url.match(
		/^https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/,
	);

	if (!match) {
		return null;
	}

	return {
		guildId: match[1],
		channelId: match[2],
		messageId: match[3],
	};
}
