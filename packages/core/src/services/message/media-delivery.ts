/** Removes already-delivered media references from visible replies while retaining unrelated reply text. */
import type { ActionResult } from "../../types/components";

export function mediaContentUrlRegions(
	text: string,
): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	const lowerText = text.toLowerCase();
	let cursor = 0;
	while (cursor < text.length) {
		const http = lowerText.indexOf("http", cursor);
		if (http < 0) break;
		let end = http;
		while (
			end < text.length &&
			!/\s/u.test(text[end]) &&
			text[end] !== "<" &&
			text[end] !== ">"
		)
			end += 1;
		const lower = lowerText.slice(http, end);
		const scheme = lower.startsWith("https://")
			? 8
			: lower.startsWith("http://")
				? 7
				: 0;
		if (scheme) {
			// The endpoint may sit mid-token (trailing punctuation, query strings)
			// and after any of several `/v1/` segments; the region ends right after
			// `/content` so surrounding punctuation survives for later cleanup.
			let matchEnd = -1;
			let marker = lower.indexOf("/v1/", scheme);
			while (marker >= 0) {
				const kindEnd = lower.indexOf("/", marker + 4);
				if (kindEnd >= 0) {
					const kind = lower.slice(marker + 4, kindEnd);
					const idEnd = lower.indexOf("/", kindEnd + 1);
					if (
						["videos", "images", "audio"].includes(kind) &&
						idEnd > kindEnd + 1 &&
						lower.startsWith("content", idEnd + 1)
					) {
						matchEnd = idEnd + 1 + "content".length;
					}
				}
				marker = lower.indexOf("/v1/", marker + 4);
			}
			if (matchEnd > 0) {
				regions.push({ start: http, end: http + matchEnd });
			}
		}
		cursor = Math.max(end, http + 1);
	}
	return regions;
}

export function removeRegions(
	text: string,
	regions: Array<{ start: number; end: number }>,
): string {
	if (regions.length === 0) return text;
	const chunks: string[] = [];
	let cursor = 0;
	for (const region of regions) {
		let start = region.start;
		let end = region.end;
		while (start > cursor && /\s/u.test(text[start - 1])) start -= 1;
		if (text[start - 1] === "<") start -= 1;
		while (end < text.length && /\s/u.test(text[end])) end += 1;
		if (text[end] === ">") end += 1;
		chunks.push(text.slice(cursor, start));
		cursor = end;
	}
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

export function removeDeliveredUrl(text: string, url: string): string {
	const regions: Array<{ start: number; end: number }> = [];
	const lower = text.toLowerCase();
	const needle = url.toLowerCase();
	let cursor = 0;
	while (needle && cursor < text.length) {
		const start = lower.indexOf(needle, cursor);
		if (start < 0) break;
		regions.push({ start, end: start + url.length });
		cursor = start + url.length;
	}
	return removeRegions(text, regions);
}

export const MEDIA_DELIVERY_PREAMBLES = [
	...["here", "here's", "here is", "here you go"].flatMap((base) => [
		`${base} it is`,
		base,
	]),
	"done.",
	...["video", "video'", "videos", "video's"].flatMap((subject) =>
		["up", "live", "ready"].map((state) => `done ${subject} ${state}`),
	),
	"done",
	"your video is ready",
	"your video",
].sort((left, right) => right.length - left.length);

export function stripMediaDeliveryPreamble(text: string): string {
	const lower = text.toLowerCase();
	for (const prefix of MEDIA_DELIVERY_PREAMBLES) {
		if (!lower.startsWith(prefix)) continue;
		let cursor = prefix.length;
		if (
			cursor < text.length &&
			!/\s/u.test(text[cursor]) &&
			text[cursor] !== ":"
		)
			continue;
		while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
		if (text[cursor] === ":") cursor += 1;
		while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
		return text.slice(cursor);
	}
	return text;
}

export function collectMediaDeliveryUrls(
	actionResults: ActionResult[],
): string[] {
	const urls = new Set<string>();
	for (const result of actionResults) {
		if (!result.success) continue;
		const data = result.data;
		if (!data || typeof data !== "object") continue;
		for (const key of [
			"videoUrl",
			"mediaUrl",
			"imageUrl",
			"audioUrl",
			"url",
		] as const) {
			const value = data[key];
			if (typeof value === "string" && value.trim()) {
				urls.add(value.trim());
			}
		}
	}
	return [...urls];
}

export function sanitizeReplyTextAfterMediaDelivery(
	text: string,
	deliveredUrls: readonly string[],
): string {
	let cleaned = text.trim();
	if (!cleaned) return cleaned;

	// This sanitizer exists ONLY to tidy a reply after a media URL was
	// delivered/stripped. A turn with no delivered media and no embedded media
	// content URL is an ordinary reply — return it untouched. Running the
	// whitespace tidy-up below on every planner reply flattened ALL multiline
	// output (code bodies, lists, paragraphs) to one line, because
	// `\s{2,}` matches `\n` + indentation (observed: every HumanEval
	// completion through the eliza harness lost its newlines and failed with
	// SyntaxError).
	const embeddedRegions = mediaContentUrlRegions(cleaned);
	const hasEmbeddedMediaUrl = embeddedRegions.length > 0;
	if (deliveredUrls.length === 0 && !hasEmbeddedMediaUrl) {
		return cleaned;
	}

	for (const url of deliveredUrls) {
		cleaned = removeDeliveredUrl(cleaned, url);
	}
	cleaned = removeRegions(cleaned, mediaContentUrlRegions(cleaned));
	cleaned = cleaned
		.replace(/:\s*$/g, "")
		.replace(/<\s*>/g, "")
		.replace(/\(\s*\)/g, "")
		// Collapse only same-line whitespace gaps left by URL removal —
		// newlines are reply formatting and must survive.
		.replace(/[^\S\n]{2,}/g, " ")
		.trim();
	cleaned = stripMediaDeliveryPreamble(cleaned).trim();

	if (
		/^(?:here|done|your video\b|it is|video'?s?\s+(?:up|live|ready))[^.?!]*:?\s*$/i.test(
			cleaned,
		)
	) {
		cleaned = "";
	}

	return cleaned;
}
