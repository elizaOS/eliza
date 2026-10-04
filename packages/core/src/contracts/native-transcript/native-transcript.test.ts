import { describe, expect, it } from "vitest";
import { decodeTranscriptStream } from "./decode";
import fixture from "./fixtures/native-transcript-golden.json";
import { reduceTranscriptEvents } from "./reduce";
import { decodeTranscriptViewModel } from "./view-model-decode";

describe("native transcript cross-platform conformance", () => {
	for (const scenario of fixture.scenarios) {
		it(scenario.name, () => {
			const decoded = decodeTranscriptStream({
				schema: fixture.schema,
				events: scenario.events,
			});
			expect(decoded.rejected.map(({ index }) => index)).toEqual(
				scenario.expectRejectedIndexes,
			);
			const view = reduceTranscriptEvents(decoded.events);
			// JSON is the native wire representation; optional undefined fields are omitted.
			expect(JSON.parse(JSON.stringify(view))).toEqual(scenario.expectView);
			expect(decodeTranscriptViewModel(view)).toMatchObject({ ok: true });
		});
	}
});
