/**
 * Canonical phase classifier for TRANSCRIPTION failures, shared by ingest
 * (`services/message.ts` processAttachments) and the on-demand read path
 * (`features/working-memory/readAttachmentAction.ts`) so both sides agree on
 * which failures may become durable STT-disabled evidence. Three phases:
 * `fetch` (the byte fetch failed before any TRANSCRIPTION provider ran),
 * `transient` (a provider was reachable but failed retryably — network blip,
 * provider 5xx), and `unavailable` (no TRANSCRIPTION provider can serve at
 * all). Only `unavailable` may write the anchored "transcription unavailable"
 * marker the read action reports as "speech-to-text isn't enabled"; the other
 * two phases must stay retryable so a transient outage never turns into a
 * stored disabled state. Classification fails closed: anything unrecognized is
 * `transient`.
 */

export type TranscriptionFailurePhase = "fetch" | "transient" | "unavailable";

/**
 * Anchored writer-controlled unavailability marker prefix ("Transcription
 * unavailable:" on-demand, "Audio/Video transcription unavailable:" ingest).
 * The appended error prose can echo a hostile remote body (media/fetch.ts
 * embeds up to ~200 chars of it), so mid-string matches must never count as
 * unavailability evidence. A live re-attempt supersedes ANY stored note,
 * marker or not: by classification time only a record that could not be
 * re-attempted (no url) or one the CURRENT attempt marked unavailable still
 * carries it.
 */
export const TRANSCRIPTION_UNAVAILABLE_MARKER =
	/^(?:(?:audio|video)\s+)?transcription unavailable/i;

/**
 * No-provider-can-serve message shapes: the runtime's missing-handler error,
 * a provider's fall-through prose, and configuration-absence wording. Kept
 * deliberately narrow — a transient provider error must never match.
 */
const UNAVAILABLE_MESSAGE =
	/falling through to next TRANSCRIPTION handler|no (?:model )?handler.*TRANSCRIPTION|no TRANSCRIPTION (?:model|provider|handler)|TRANSCRIPTION.*not (?:available|enabled|registered|configured)/i;

/**
 * Classifies a transcription-attempt failure into its phase. Fetch-layer
 * failures are matched by error name rather than instanceof so the exclusion
 * survives module duplication across the multi-target build and test module
 * mocks — and they win before any message check because MediaFetchError
 * messages can embed hostile remote-body prose that mimics unavailability. A
 * typed `*UnavailableError` (e.g. `CloudSttUnavailableError`) or a
 * no-provider message shape is genuine unavailability; everything else —
 * non-Error throws included — is transient.
 */
export function classifyTranscriptionFailure(
	err: unknown,
): TranscriptionFailurePhase {
	if (err instanceof Error && err.name === "MediaFetchError") return "fetch";
	if (!(err instanceof Error)) return "transient";
	if (err.name.endsWith("UnavailableError")) return "unavailable";
	return UNAVAILABLE_MESSAGE.test(err.message) ? "unavailable" : "transient";
}

/**
 * Builds the ingest-time `notProcessed` marker for a failed transcription
 * attempt. Only the `unavailable` phase produces the anchored marker the read
 * action treats as STT-disabled evidence; `fetch` and `transient` phases get
 * markers whose prefixes can never match `TRANSCRIPTION_UNAVAILABLE_MARKER`,
 * so the read path keeps the retryable "yet" reply for them.
 */
export function transcriptionFailureMarker(
	kind: "Audio" | "Video",
	err: unknown,
): string {
	const message = err instanceof Error ? err.message : String(err);
	switch (classifyTranscriptionFailure(err)) {
		case "fetch":
			return `${kind} attachment could not be fetched: ${message}`;
		case "transient":
			return `${kind} transcription failed transiently: ${message}`;
		case "unavailable":
			return `${kind} transcription unavailable: ${message}`;
	}
}
