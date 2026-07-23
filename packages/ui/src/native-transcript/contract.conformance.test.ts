/**
 * Cross-platform conformance: drives the language-neutral golden fixture
 * (`fixtures/native-transcript-golden.json`) through the real decoder + reducer
 * and asserts the reduced view exactly matches each scenario's `expectView`.
 * This is the same fixture the iOS/Android native decoders must satisfy, so a
 * failure here is a contract break, not a rendering nit. Deterministic — no
 * clock, RNG, or I/O beyond reading the fixture file.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_TRANSCRIPT_SCHEMA } from "./contract";
import { decodeTranscriptStream } from "./decode";
import { reduceTranscriptEvents } from "./reduce";

interface GoldenScenario {
  name: string;
  case?: string;
  events: unknown[];
  expectRejectedIndexes: number[];
  expectView: unknown;
}
interface GoldenFixture {
  schema: string;
  scenarios: GoldenScenario[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/native-transcript-golden.json", import.meta.url),
    "utf8",
  ),
) as GoldenFixture;

describe("native-transcript golden conformance", () => {
  it("fixture is tagged with the current schema version", () => {
    expect(fixture.schema).toBe(NATIVE_TRANSCRIPT_SCHEMA);
    expect(fixture.scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of fixture.scenarios) {
    it(`${scenario.name} — ${scenario.case ?? ""}`, () => {
      const decoded = decodeTranscriptStream({
        schema: NATIVE_TRANSCRIPT_SCHEMA,
        events: scenario.events,
      });
      expect(decoded.rejected.map((r) => r.index)).toEqual(
        scenario.expectRejectedIndexes,
      );
      const view = reduceTranscriptEvents(decoded.events);
      expect(view).toEqual(scenario.expectView);
    });
  }
});
