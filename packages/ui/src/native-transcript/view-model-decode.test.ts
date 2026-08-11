/**
 * Native-return boundary coverage: every language-neutral golden projection is
 * accepted, while malformed item/state shapes fail explicitly before React.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeTranscriptViewModel } from "./view-model-decode";

interface GoldenScenario {
  name: string;
  expectView: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/native-transcript-golden.json", import.meta.url),
    "utf8",
  ),
) as { scenarios: GoldenScenario[] };

describe("decodeTranscriptViewModel", () => {
  for (const scenario of fixture.scenarios) {
    it(`accepts golden native view: ${scenario.name}`, () => {
      const decoded = decodeTranscriptViewModel(scenario.expectView);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.view).toEqual(scenario.expectView);
    });
  }

  it.each([
    ["non-object", null, "view"],
    [
      "unknown item kind",
      {
        items: [{ kind: "guess", id: "1" }],
        speaking: null,
        connection: "live",
        lastSeq: 1,
      },
      "view.items[0].kind",
    ],
    [
      "invalid status",
      {
        items: [
          {
            kind: "user",
            id: "1",
            text: "hello",
            status: "streaming",
            words: [],
          },
        ],
        speaking: null,
        connection: "live",
        lastSeq: 1,
      },
      "view.items[0].status",
    ],
    [
      "unsafe sequence",
      {
        items: [],
        speaking: null,
        connection: "live",
        lastSeq: Number.MAX_SAFE_INTEGER + 1,
      },
      "view.lastSeq",
    ],
    [
      "malformed speaking state",
      {
        items: [],
        speaking: { utteranceId: "" },
        connection: "live",
        lastSeq: 1,
      },
      "view.speaking.utteranceId",
    ],
  ])("rejects %s", (_name, view, path) => {
    const decoded = decodeTranscriptViewModel(view);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.path).toBe(path);
  });
});
