/**
 * Classifies attachment-transcription failures at the fetch/provider boundary.
 * Both ingest and on-demand retry use this contract so only definitive STT
 * configuration failures produce the durable unavailable marker.
 */

export type TranscriptionFailurePhase = "fetch" | "provider";

export type TranscriptionFailure = {
	kind: "fetch_retryable" | "provider_retryable" | "provider_unavailable";
	error: unknown;
	message: string;
};

export type TranscriptionMediaKind = "Audio" | "Video";

const DEFINITIVE_STT_UNAVAILABLE_ERROR_NAMES = new Set([
	"CloudSttUnavailableError",
]);
const NO_TRANSCRIPTION_HANDLER =
	/^No handler found for delegate type: TRANSCRIPTION$/;
const TRANSCRIPTION_UNAVAILABLE_NOTE =
	/^(?:(?:audio|video)\s+)?transcription unavailable:/i;

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch failures are always retryable because no provider ran. Provider
 * failures are definitive only when they carry a canonical typed unavailable
 * name or the runtime's exact no-handler signal; status prose such as 502/503
 * deliberately remains retryable.
 */
export function classifyTranscriptionFailure(
	error: unknown,
	phase: TranscriptionFailurePhase,
): TranscriptionFailure {
	const message = failureMessage(error);
	if (phase === "fetch") {
		return { kind: "fetch_retryable", error, message };
	}
	if (
		error instanceof Error &&
		(DEFINITIVE_STT_UNAVAILABLE_ERROR_NAMES.has(error.name) ||
			NO_TRANSCRIPTION_HANDLER.test(error.message))
	) {
		return { kind: "provider_unavailable", error, message };
	}
	return { kind: "provider_retryable", error, message };
}

/** The only note shape that may drive the user-facing STT-disabled state. */
export function isTranscriptionUnavailableNote(note: unknown): boolean {
	return typeof note === "string" && TRANSCRIPTION_UNAVAILABLE_NOTE.test(note);
}

/**
 * Creates the durable ingest/on-demand diagnostic note from the shared
 * classification. Retryable provider failures intentionally avoid the
 * unavailable prefix so later reads never treat a 5xx as disabled STT.
 */
export function transcriptionFailureNote(
	failure: TranscriptionFailure,
	mediaKind?: TranscriptionMediaKind,
): string {
	const attachment = mediaKind ? `${mediaKind} attachment` : "Attachment";
	const transcription = mediaKind
		? `${mediaKind} transcription`
		: "Transcription";
	switch (failure.kind) {
		case "fetch_retryable":
			return `${attachment} could not be fetched: ${failure.message}`;
		case "provider_retryable":
			return `${transcription} could not complete: ${failure.message}`;
		case "provider_unavailable":
			return `${transcription} unavailable: ${failure.message}`;
	}
}
