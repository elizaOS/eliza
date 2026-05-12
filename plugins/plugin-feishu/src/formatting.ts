/**
 * Feishu text chunk limit
 */
export const FEISHU_TEXT_CHUNK_LIMIT = 4000;

/**
 * Feishu Post (rich text) element types
 */
export type FeishuPostElement =
	| { tag: "text"; text: string; style?: string[] }
	| { tag: "a"; text: string; href: string; style?: string[] }
	| { tag: "at"; user_id: string }
	| { tag: "img"; image_key: string }
	| { tag: "media"; file_key: string }
	| { tag: "emotion"; emoji_type: string };

/**
 * A line of Feishu Post content
 */
export type FeishuPostLine = FeishuPostElement[];

/**
 * Feishu Post content structure
 */
export interface FeishuPostContent {
	zh_cn?: {
		title?: string;
		content: FeishuPostLine[];
	};
	en_us?: {
		title?: string;
		content: FeishuPostLine[];
	};
}

/**
 * Result of formatting markdown for Feishu
 */
export interface FeishuFormattedChunk {
	post: FeishuPostContent;
	text: string;
}

/**
 * Style state for text formatting
 */
interface StyleState {
	bold: boolean;
	italic: boolean;
	strikethrough: boolean;
	code: boolean;
}

/**
 * Link span information
 */
interface LinkSpan {
	start: number;
	end: number;
	href: string;
	text: string;
}

/**
 * Style span information
 */
interface StyleSpan {
	start: number;
	end: number;
	style: "bold" | "italic" | "strikethrough" | "code";
}

/**
 * Intermediate representation of parsed markdown
 */
interface MarkdownIR {
	text: string;
	styles: StyleSpan[];
	links: LinkSpan[];
}

/**
 * Options for text chunking
 */
export interface ChunkFeishuTextOpts {
	limit?: number;
}

/**
 * Parse markdown to intermediate representation
 */
function parseMarkdownToIR(markdown: string): MarkdownIR {
	const styles: StyleSpan[] = [];
	const links: LinkSpan[] = [];
	let text = markdown;

	// Process links first [text](url)
	const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
	const linkReplacements: {
		start: number;
		end: number;
		text: string;
		href: string;
	}[] = [];

	let linkMatch = linkRegex.exec(markdown);
	while (linkMatch !== null) {
		linkReplacements.push({
			start: linkMatch.index,
			end: linkMatch.index + linkMatch[0].length,
			text: linkMatch[1],
			href: linkMatch[2],
		});
		linkMatch = linkRegex.exec(markdown);
	}

	// Apply link replacements in reverse order
	let offset = 0;
	for (const repl of linkReplacements) {
		const before = text.slice(0, repl.start + offset);
		const after = text.slice(repl.end + offset);
		text = before + repl.text + after;

		links.push({
			start: repl.start + offset,
			end: repl.start + offset + repl.text.length,
			href: repl.href,
			text: repl.text,
		});

		offset += repl.text.length - (repl.end - repl.start);
	}

	// Process bold **text** or __text__
	text = processStyle(text, /\*\*([^*]+)\*\*/g, "bold", styles);
	text = processStyle(text, /__([^_]+)__/g, "bold", styles);

	// Process italic *text* or _text_
	text = processStyle(
		text,
		/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g,
		"italic",
		styles,
	);
	text = processStyle(
		text,
		/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g,
		"italic",
		styles,
	);

	// Process strikethrough ~~text~~
	text = processStyle(text, /~~([^~]+)~~/g, "strikethrough", styles);

	// Process inline code `text`
	text = processStyle(text, /`([^`]+)`/g, "code", styles);

	// Process code blocks ```text```
	text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
		const start = text.indexOf(_);
		const trimmedCode = code.trim();
		styles.push({
			start,
			end: start + trimmedCode.length,
			style: "code",
		});
		return trimmedCode;
	});

	// Remove markdown headers
	text = text.replace(/^#{1,6}\s+/gm, "");

	// Remove blockquote markers
	text = text.replace(/^>\s?/gm, "｜ ");

	// Clean up
	text = text.replace(/\n{3,}/g, "\n\n").trim();

	return { text, styles, links };
}

/**
 * Process a style pattern and update the text and styles
 */
function processStyle(
	text: string,
	pattern: RegExp,
	style: StyleSpan["style"],
	styles: StyleSpan[],
): string {
	let result = text;
	const matches: { index: number; fullLength: number; content: string }[] = [];

	let match = pattern.exec(text);
	while (match !== null) {
		matches.push({
			index: match.index,
			fullLength: match[0].length,
			content: match[1],
		});
		match = pattern.exec(text);
	}

	// Process in reverse to maintain indices
	let offset = 0;
	for (const m of matches) {
		const before = result.slice(0, m.index + offset);
		const after = result.slice(m.index + offset + m.fullLength);
		result = before + m.content + after;

		styles.push({
			start: m.index + offset,
			end: m.index + offset + m.content.length,
			style,
		});

		offset += m.content.length - m.fullLength;
	}

	return result;
}

/**
 * Build style ranges for quick lookup
 */
function buildStyleRanges(
	styles: StyleSpan[],
	textLength: number,
): StyleState[] {
	const ranges: StyleState[] = Array(textLength)
		.fill(null)
		.map(() => ({
			bold: false,
			italic: false,
			strikethrough: false,
			code: false,
		}));

	for (const span of styles) {
		for (let i = span.start; i < span.end && i < textLength; i++) {
			switch (span.style) {
				case "bold":
					ranges[i].bold = true;
					break;
				case "italic":
					ranges[i].italic = true;
					break;
				case "strikethrough":
					ranges[i].strikethrough = true;
					break;
				case "code":
					ranges[i].code = true;
					break;
			}
		}
	}

	return ranges;
}

/**
 * Build link map for quick lookup
 */
function buildLinkMap(links: LinkSpan[]): Map<number, string> {
	const map = new Map<number, string>();
	for (const link of links) {
		for (let i = link.start; i < link.end; i++) {
			map.set(i, link.href);
		}
	}
	return map;
}

/**
 * Get styles at a specific position
 */
function getStylesAt(ranges: StyleState[], pos: number): StyleState {
	return (
		ranges[pos] ?? {
			bold: false,
			italic: false,
			strikethrough: false,
			code: false,
		}
	);
}

/**
 * Get link at a specific position
 */
function getLinkAt(
	linkMap: Map<number, string>,
	pos: number,
): string | undefined {
	return linkMap.get(pos);
}

/**
 * Check if two style states are equal
 */
function stylesEqual(a: StyleState, b: StyleState): boolean {
	return (
		a.bold === b.bold &&
		a.italic === b.italic &&
		a.strikethrough === b.strikethrough &&
		a.code === b.code
	);
}

/**
 * Create a Feishu Post element
 */
function createPostElement(
	text: string,
	styles: StyleState,
	link?: string,
): FeishuPostElement {
	const styleArray: string[] = [];

	if (styles.bold) {
		styleArray.push("bold");
	}
	if (styles.italic) {
		styleArray.push("italic");
	}
	if (styles.strikethrough) {
		styleArray.push("lineThrough");
	}
	if (styles.code) {
		styleArray.push("code");
	}

	if (link) {
		return {
			tag: "a",
			text,
			href: link,
			...(styleArray.length > 0 ? { style: styleArray } : {}),
		};
	}

	return {
		tag: "text",
		text,
		...(styleArray.length > 0 ? { style: styleArray } : {}),
	};
}

/**
 * Render markdown IR to Feishu Post format
 */
function renderFeishuPost(ir: MarkdownIR): FeishuPostContent {
	const lines: FeishuPostLine[] = [];
	const text = ir.text;

	if (!text) {
		return { zh_cn: { content: [[{ tag: "text", text: "" }]] } };
	}

	const styleRanges = buildStyleRanges(ir.styles, text.length);
	const linkMap = buildLinkMap(ir.links);

	const textLines = text.split("\n");
	let charIndex = 0;

	for (const line of textLines) {
		const lineElements: FeishuPostElement[] = [];

		if (line.length === 0) {
			lineElements.push({ tag: "text", text: "" });
		} else {
			let segmentStart = charIndex;
			let currentStyles = getStylesAt(styleRanges, segmentStart);
			let currentLink = getLinkAt(linkMap, segmentStart);

			for (let i = 0; i < line.length; i++) {
				const pos = charIndex + i;
				const newStyles = getStylesAt(styleRanges, pos);
				const newLink = getLinkAt(linkMap, pos);

				const stylesChanged = !stylesEqual(currentStyles, newStyles);
				const linkChanged = currentLink !== newLink;

				if (stylesChanged || linkChanged) {
					const segmentText = text.slice(segmentStart, pos);
					if (segmentText) {
						lineElements.push(
							createPostElement(segmentText, currentStyles, currentLink),
						);
					}
					segmentStart = pos;
					currentStyles = newStyles;
					currentLink = newLink;
				}
			}

			const finalText = text.slice(segmentStart, charIndex + line.length);
			if (finalText) {
				lineElements.push(
					createPostElement(finalText, currentStyles, currentLink),
				);
			}
		}

		lines.push(
			lineElements.length > 0 ? lineElements : [{ tag: "text", text: "" }],
		);
		charIndex += line.length + 1;
	}

	return {
		zh_cn: {
			content: lines,
		},
	};
}

/**
 * Convert markdown to Feishu Post format
 */
export function markdownToFeishuPost(markdown: string): FeishuPostContent {
	const ir = parseMarkdownToIR(markdown ?? "");
	return renderFeishuPost(ir);
}

/**
 * Splits text at the last safe break point within the limit
 */
function splitAtBreakPoint(
	text: string,
	limit: number,
): { chunk: string; remainder: string } {
	if (text.length <= limit) {
		return { chunk: text, remainder: "" };
	}

	const searchArea = text.slice(0, limit);

	// Prefer double newlines (paragraph breaks)
	const doubleNewline = searchArea.lastIndexOf("\n\n");
	if (doubleNewline > limit * 0.5) {
		return {
			chunk: text.slice(0, doubleNewline).trimEnd(),
			remainder: text.slice(doubleNewline + 2).trimStart(),
		};
	}

	// Try single newlines
	const singleNewline = searchArea.lastIndexOf("\n");
	if (singleNewline > limit * 0.5) {
		return {
			chunk: text.slice(0, singleNewline).trimEnd(),
			remainder: text.slice(singleNewline + 1).trimStart(),
		};
	}

	// Try sentence boundaries
	const sentenceEnd = Math.max(
		searchArea.lastIndexOf(". "),
		searchArea.lastIndexOf("! "),
		searchArea.lastIndexOf("? "),
	);
	if (sentenceEnd > limit * 0.5) {
		return {
			chunk: text.slice(0, sentenceEnd + 1).trimEnd(),
			remainder: text.slice(sentenceEnd + 2).trimStart(),
		};
	}

	// Try word boundaries
	const space = searchArea.lastIndexOf(" ");
	if (space > limit * 0.5) {
		return {
			chunk: text.slice(0, space).trimEnd(),
			remainder: text.slice(space + 1).trimStart(),
		};
	}

	// Hard break at limit
	return {
		chunk: text.slice(0, limit),
		remainder: text.slice(limit),
	};
}

/**
 * Chunk text for Feishu messages
 */
export function chunkFeishuText(
	text: string,
	opts: ChunkFeishuTextOpts = {},
): string[] {
	const limit = opts.limit ?? FEISHU_TEXT_CHUNK_LIMIT;

	if (!text?.trim()) {
		return [];
	}

	const normalizedText = text.trim();
	if (normalizedText.length <= limit) {
		return [normalizedText];
	}

	const chunks: string[] = [];
	let remaining = normalizedText;

	while (remaining.length > 0) {
		const { chunk, remainder } = splitAtBreakPoint(remaining, limit);
		if (chunk) {
			chunks.push(chunk);
		}
		remaining = remainder;
	}

	return chunks.filter((c) => c.length > 0);
}

/**
 * Convert markdown to Feishu Post chunks
 */
export function markdownToFeishuChunks(
	markdown: string,
	limit: number = FEISHU_TEXT_CHUNK_LIMIT,
): FeishuFormattedChunk[] {
	const textChunks = chunkFeishuText(markdown, { limit });
	return textChunks.map((chunk) => ({
		post: markdownToFeishuPost(chunk),
		text: chunk,
	}));
}

/**
 * Check if text contains markdown formatting
 */
export function containsMarkdown(text: string): boolean {
	if (!text) {
		return false;
	}
	const markdownPatterns = [
		/\*\*[^*]+\*\*/,
		/\*[^*]+\*/,
		/~~[^~]+~~/,
		/`[^`]+`/,
		/```[\s\S]*```/,
		/\[.+\]\(.+\)/,
		/^#{1,6}\s/m,
		/^[-*]\s/m,
		/^\d+\.\s/m,
	];
	return markdownPatterns.some((pattern) => pattern.test(text));
}

/**
 * Strip markdown formatting from text
 */
export function stripMarkdown(text: string): string {
	let result = text;

	// Remove bold
	result = result.replace(/\*\*(.+?)\*\*/g, "$1");
	result = result.replace(/__(.+?)__/g, "$1");

	// Remove italic
	result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
	result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1");

	// Remove strikethrough
	result = result.replace(/~~(.+?)~~/g, "$1");

	// Remove headers
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");

	// Remove blockquotes
	result = result.replace(/^>\s?(.*)$/gm, "$1");

	// Remove code blocks
	result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, "$2");

	// Remove inline code
	result = result.replace(/`([^`]+)`/g, "$1");

	// Remove links - keep text
	result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

	// Clean up
	result = result.replace(/\n{3,}/g, "\n\n");
	result = result.trim();

	return result;
}

/**
 * Format Feishu user mention
 */
export function formatFeishuUserMention(userId: string): string {
	return `<at user_id="${userId}"></at>`;
}

/**
 * Format Feishu user mention for all users
 */
export function formatFeishuAtAll(): string {
	return '<at user_id="all"></at>';
}

/**
 * Truncate text to a maximum length
 */
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	if (maxLength <= 3) {
		return "...".slice(0, maxLength);
	}
	return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Resolve system location for logging
 */
export function resolveFeishuSystemLocation(params: {
	chatType: "p2p" | "group";
	chatId: string;
	chatName?: string;
}): string {
	const { chatType, chatId, chatName } = params;
	const name = chatName || chatId.slice(0, 8);
	return `Feishu ${chatType}:${name}`;
}

/**
 * Check if chat is a group chat
 */
export function isGroupChat(chatType: string): boolean {
	return chatType === "group";
}
