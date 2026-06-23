import type { GenerateTextResult } from "../../types/model";

export function getV5ModelText(raw: string | GenerateTextResult): string {
	if (typeof raw === "string") {
		return raw;
	}
	if (typeof raw.text === "string" && raw.text.trim().length > 0) {
		return raw.text;
	}
	const contentText = extractGenerateTextContentText(raw);
	if (contentText.trim().length > 0) {
		return contentText;
	}
	const responseText = raw.response;
	if (typeof responseText === "string" && responseText.trim().length > 0) {
		return responseText;
	}
	return typeof raw.text === "string" ? raw.text : JSON.stringify(raw);
}

export function extractGenerateTextContentText(
	raw: GenerateTextResult,
): string {
	const content = raw.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type =
			typeof part.type === "string" ? part.type.toLowerCase() : undefined;
		const text =
			typeof part.text === "string"
				? part.text
				: typeof part.content === "string"
					? part.content
					: "";
		if (!text) continue;
		if (!type || type === "text" || type === "output_text") {
			parts.push(text);
		}
	}
	return parts.join("");
}
