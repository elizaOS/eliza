/**
 * Deterministic unit coverage of the shared transcription failure phase
 * classifier consumed by both the ingest catch (services/message.ts) and the
 * on-demand read path (working-memory/readAttachmentAction.ts). No runtime,
 * no network — plain error-shape fixtures, including adversarial ones whose
 * prose mimics unavailability.
 */
import { describe, expect, it } from "vitest";
import { MediaFetchError } from "./fetch.ts";
import {
	classifyTranscriptionFailure,
	TRANSCRIPTION_UNAVAILABLE_MARKER,
	transcriptionFailureMarker,
} from "./transcription.ts";

describe("classifyTranscriptionFailure", () => {
	it("classifies MediaFetchError as fetch-phase even when its prose mimics unavailability", () => {
		// media/fetch.ts embeds up to ~200 chars of the remote body in the
		// message; a hostile host planting unavailability prose there must not
		// forge the disabled state.
		const err = new MediaFetchError(
			"http_error",
			"HTTP 503; body: TRANSCRIPTION not available — falling through to next TRANSCRIPTION handler",
		);
		expect(classifyTranscriptionFailure(err)).toBe("fetch");
	});

	it("matches fetch-phase by error NAME so it survives module duplication", () => {
		const duplicated = new Error("Could not fetch attachment locally");
		duplicated.name = "MediaFetchError";
		expect(classifyTranscriptionFailure(duplicated)).toBe("fetch");
	});

	it.each([
		["provider 5xx", new Error("upstream STT returned 502 Bad Gateway")],
		["network blip", new Error("fetch failed: connect ETIMEDOUT")],
		[
			"abort/timeout",
			Object.assign(new Error("The operation was aborted"), {
				name: "AbortError",
			}),
		],
		["non-Error throw", "provider exploded" as unknown],
	])("classifies a %s as transient (fail-closed default)", (_label, err) => {
		expect(classifyTranscriptionFailure(err)).toBe("transient");
	});

	it.each([
		[
			"typed *UnavailableError",
			Object.assign(new Error("Eliza Cloud STT is not available"), {
				name: "CloudSttUnavailableError",
			}),
		],
		[
			"runtime missing-handler error",
			new Error("No handler found for delegate type: TRANSCRIPTION"),
		],
		[
			"provider fall-through prose",
			new Error("falling through to next TRANSCRIPTION handler"),
		],
		[
			"configuration-absence prose",
			new Error("no transcription provider configured"),
		],
	])("classifies %s as genuine unavailability", (_label, err) => {
		expect(classifyTranscriptionFailure(err)).toBe("unavailable");
	});
});

describe("transcriptionFailureMarker", () => {
	it("writes the anchored unavailable marker ONLY for the unavailable phase", () => {
		const unavailable = Object.assign(new Error("STT gated off"), {
			name: "CloudSttUnavailableError",
		});
		expect(transcriptionFailureMarker("Audio", unavailable)).toBe(
			"Audio transcription unavailable: STT gated off",
		);
		expect(
			TRANSCRIPTION_UNAVAILABLE_MARKER.test(
				transcriptionFailureMarker("Video", unavailable),
			),
		).toBe(true);
	});

	it("keeps fetch-phase and transient markers outside the anchored marker", () => {
		const fetchErr = new MediaFetchError(
			"http_error",
			"HTTP 503; body: transcription unavailable",
		);
		const transientErr = new Error("provider returned 502");
		const fetchMarker = transcriptionFailureMarker("Audio", fetchErr);
		const transientMarker = transcriptionFailureMarker("Video", transientErr);
		expect(fetchMarker).toBe(
			"Audio attachment could not be fetched: HTTP 503; body: transcription unavailable",
		);
		expect(transientMarker).toBe(
			"Video transcription failed transiently: provider returned 502",
		);
		// Mid-string hostile prose never counts: the marker regex is anchored.
		expect(TRANSCRIPTION_UNAVAILABLE_MARKER.test(fetchMarker)).toBe(false);
		expect(TRANSCRIPTION_UNAVAILABLE_MARKER.test(transientMarker)).toBe(false);
	});

	it("stringifies non-Error throws without granting them unavailability", () => {
		const marker = transcriptionFailureMarker("Audio", "boom");
		expect(marker).toBe("Audio transcription failed transiently: boom");
		expect(TRANSCRIPTION_UNAVAILABLE_MARKER.test(marker)).toBe(false);
	});
});
