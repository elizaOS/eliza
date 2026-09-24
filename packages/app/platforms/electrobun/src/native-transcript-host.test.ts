/**
 * Runs the exact language-neutral transcript fixture through the real
 * Electrobun host boundary, including malformed-event reporting and reduction.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  publishNativeTranscriptStream,
  resetNativeTranscriptHostForTests,
} from "./native-transcript-host";

interface GoldenScenario {
  name: string;
  events: unknown[];
  expectRejectedIndexes: number[];
  expectView: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../ui/src/native-transcript/fixtures/native-transcript-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { schema: string; scenarios: GoldenScenario[] };

describe("Electrobun native transcript host", () => {
  for (const scenario of fixture.scenarios) {
    it(`conforms: ${scenario.name}`, () => {
      resetNativeTranscriptHostForTests();
      const result = publishNativeTranscriptStream({
        schema: fixture.schema,
        events: scenario.events,
      });
      expect(result.rejectedIndexes).toEqual(scenario.expectRejectedIndexes);
      expect(result.view).toEqual(scenario.expectView);
    });
  }

  it("continues an append-only stream across renderer batches", () => {
    resetNativeTranscriptHostForTests();
    publishNativeTranscriptStream({
      schema: fixture.schema,
      events: [{ type: "stt.partial", seq: 1, turnId: "turn", text: "hel" }],
    });
    const result = publishNativeTranscriptStream({
      schema: fixture.schema,
      events: [{ type: "stt.final", seq: 2, turnId: "turn", text: "hello" }],
    });
    expect(result.view.items).toEqual([
      {
        kind: "user",
        id: "turn",
        status: "final",
        text: "hello",
        words: [],
      },
    ]);
  });
});
