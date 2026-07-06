/**
 * Transcript → knowledge (documents store) mapping (#8789 transcripts).
 *
 * A finished transcript is mirrored into the documents/knowledge store as a
 * private, searchable text item so it is parsable/readable from the Knowledge
 * view, surfaced by the documents provider, and found by the document `search`
 * action — exactly as a user would expect "search my transcripts" to work. The
 * structured record (audio + word timings + diarization) stays the source of
 * truth in the transcript store; this is the denormalized search copy, linked
 * back by `metadata.transcriptId`.
 *
 * Pure: it builds the documents-store *fields* from a shared `Transcript`; the
 * service combines them with the runtime UUIDs (world/room/entity/client ids)
 * and `addedFrom` to call `DocumentService.addDocument`.
 */

import type { Transcript, TranscriptScope } from "@elizaos/shared/transcripts";
import { transcriptPlainText } from "@elizaos/shared/transcripts";

/** The documents-store fields derived from a transcript (sans runtime UUIDs). */
export interface TranscriptKnowledgePayload {
	/** Plain, speaker-labeled transcript text — the searchable + chunked body. */
	content: string;
	/** Suggested filename (slugified title + `.txt`). */
	filename: string;
	contentType: string;
	scope: TranscriptScope;
	/** Metadata merged onto the document — tags + the link back to the record. */
	metadata: Record<string, unknown>;
}

/** Tag every mirrored transcript carries so it's filterable as a transcript. */
export const TRANSCRIPT_DOCUMENT_TAG = "transcript";

/** Lowercase ascii slug for a filename (fallback "transcript"). */
function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "transcript";
}

/**
 * Build the documents-store fields for mirroring a transcript into knowledge.
 * The body is the speaker-labeled plain text (what gets embedded + searched);
 * `metadata.transcriptId` links the knowledge item back to the rich record so a
 * Knowledge-view consumer can open it in the player.
 */
export function transcriptKnowledgePayload(
	transcript: Transcript,
): TranscriptKnowledgePayload {
	const metadata: Record<string, unknown> = {
		source: TRANSCRIPT_DOCUMENT_TAG,
		tags: [TRANSCRIPT_DOCUMENT_TAG],
		transcriptId: transcript.id,
		title: transcript.title,
		durationMs: transcript.durationMs,
		speakerCount: transcript.speakerCount,
		createdAt: transcript.createdAt,
		// Mark as text-backed so the documents UI treats it as editable/previewable
		// text rather than an opaque binary upload.
		textBacked: true,
	};
	if (transcript.audioUrl) {
		// `mediaUrl` is the key the daily media GC scans on document rows;
		// `audioUrl` alone would leave the retained WAV unreferenced and it
		// would be swept. Set both: mediaUrl anchors the media store handle,
		// audioUrl is what transcript readers look up.
		metadata.mediaUrl = transcript.audioUrl;
		metadata.audioUrl = transcript.audioUrl;
	}

	return {
		content: transcriptPlainText(transcript.segments),
		filename: `${slugify(transcript.title)}.txt`,
		contentType: "text/plain",
		scope: transcript.scope,
		metadata,
	};
}
