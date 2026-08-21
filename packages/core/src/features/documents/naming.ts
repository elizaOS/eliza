/**
 * Pure document naming helpers: title derivation from content and safe note
 * filenames. Split from `utils.ts` so callers that only name documents (the
 * working-memory attachment action, character ingestion) do not drag the
 * heavyweight parser graph (mammoth/unpdf) into edge and browser bundles;
 * `utils.ts` re-exports these, so existing import sites keep working.
 */

import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

export const DOCUMENT_TITLE_MAX_LENGTH = 80;

export function truncateDocumentLabel(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= DOCUMENT_TITLE_MAX_LENGTH) {
		return wellFormed;
	}
	const budget = Math.max(0, DOCUMENT_TITLE_MAX_LENGTH - 1);
	return `${truncateWellFormed(wellFormed, budget).trimEnd()}…`;
}

export function stripDocumentFilenameExtension(filename: string): string {
	const trimmed = filename.trim();
	if (!trimmed) return "";

	const lastDot = trimmed.lastIndexOf(".");
	if (lastDot <= 0) return trimmed;
	return trimmed.slice(0, lastDot);
}

export function deriveDocumentTitle(
	content: string,
	fallback = "Document note",
): string {
	const lines = content
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (const line of lines) {
		if (/^path:\s+/i.test(line)) continue;
		const candidate = line
			.replace(/^#+\s*/, "")
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.trim();
		if (candidate.length > 0) {
			return truncateDocumentLabel(candidate);
		}
	}

	return fallback;
}

export function createDocumentNoteFilename(
	title: string,
	extension = "txt",
): string {
	const asciiTitle = Array.from(title.normalize("NFKD"))
		.filter((character) => character.charCodeAt(0) <= 0x7f)
		.join("");
	const normalizedTitle = asciiTitle
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);

	const basename =
		normalizedTitle.length > 0 ? normalizedTitle : "document-note";
	const normalizedExtension = extension.replace(/^\./, "").trim();
	return normalizedExtension.length > 0
		? `${basename}.${normalizedExtension}`
		: basename;
}
