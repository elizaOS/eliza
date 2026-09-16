/** Normalizes inbound attachment references for storage and prompt resolution and defines explicit byte-boundary failures. */

import { ElizaError } from "../../errors";
import type { GenerateTextAttachment } from "../../types/model";
import type { Media } from "../../types/primitives";

export type MediaWithInlineData = Media & {
	_data?: unknown;
	_mimeType?: unknown;
};

/**
 * Hard cap on bytes fetched while enriching a single attachment (description /
 * transcription / text extraction). Bounds memory and is enforced by the
 * SSRF-guarded fetcher for remote URLs and explicitly for local ones.
 */
export const ATTACHMENT_FETCH_MAX_BYTES = 50 * 1024 * 1024;

/** Aggregate bytes admitted to enrichment for one message turn. */
export const ATTACHMENT_TURN_MAX_BYTES = 100 * 1024 * 1024;

export type AttachmentByteBudget = { remaining: number };

export function attachmentFailure(
	phase: NonNullable<Media["enrichmentFailure"]>["phase"],
	code: NonNullable<Media["enrichmentFailure"]>["code"],
	retryable: boolean,
	message: string,
): Pick<Media, "notProcessed" | "enrichmentFailure"> {
	return {
		notProcessed: message,
		enrichmentFailure: { phase, code, retryable },
	};
}

export function sanitizedAttachmentDiagnostic(
	code: string,
	message: string,
	attachment: Media,
): ElizaError {
	return new ElizaError(message, {
		code,
		severity: "ephemeral",
		context: {
			attachmentId: attachment.id,
			contentType: attachment.contentType,
		},
	});
}

export function sanitizeAttachmentsForStorage(
	attachments: Media[] | undefined,
): Media[] | undefined {
	if (!attachments?.length) {
		return attachments;
	}

	return attachments.map((attachment) => {
		const {
			_data: _discardData,
			_mimeType: _discardMimeType,
			...rest
		} = attachment as MediaWithInlineData;
		return rest;
	});
}

export function _resolvePromptAttachments(
	attachments: Media[] | undefined,
): GenerateTextAttachment[] | undefined {
	if (!attachments?.length) {
		return undefined;
	}

	const resolved = attachments.flatMap((attachment) => {
		const withInlineData = attachment as MediaWithInlineData;
		if (
			typeof withInlineData._data === "string" &&
			withInlineData._data.trim() &&
			typeof withInlineData._mimeType === "string" &&
			withInlineData._mimeType.trim()
		) {
			return [
				{
					data: withInlineData._data,
					mediaType: withInlineData._mimeType,
					filename: attachment.title,
				},
			];
		}

		const dataUrlMatch = attachment.url.match(/^data:([^;,]+);base64,(.+)$/i);
		if (dataUrlMatch) {
			return [
				{
					data: dataUrlMatch[2],
					mediaType: dataUrlMatch[1],
					filename: attachment.title,
				},
			];
		}

		return [];
	});

	return resolved.length > 0 ? resolved : undefined;
}
