/**
 * Brain reply reading when the planning model wraps its JSON object in
 * prose that itself contains a brace.
 *
 * `parseBrainOutput` used to snip the reply to its first `{` and last `}`
 * before `JSON.parse`. A brace inside the surrounding prose — a braced
 * word before the object, a `{` the prose never closes, or a braced word
 * after the object — corrupts that slice, so a reply carrying a complete,
 * valid BrainOutput object fails to parse: the Brain burns its strict
 * retry on a second model call and, when the model answers in the same
 * style, aborts the turn even though it decided a valid action.
 */

import { describe, expect, it } from "vitest";
import { BrainParseError, parseBrainOutput } from "./brain.js";

const OBJECT = [
  "{",
  '  "scene_summary": "A browser window shows a settings form.",',
  '  "target_display_id": 0,',
  '  "roi": [],',
  '  "proposed_action": {',
  '    "kind": "wait",',
  '    "rationale": "The page is still loading."',
  "  }",
  "}",
].join("\n");

function expectWaitAction(raw: string): void {
  const out = parseBrainOutput(raw);
  expect(out.scene_summary).toBe("A browser window shows a settings form.");
  expect(out.target_display_id).toBe(0);
  expect(out.proposed_action.kind).toBe("wait");
  expect(out.proposed_action.rationale).toBe("The page is still loading.");
}

describe("parseBrainOutput prose handling", () => {
  it("reads a bare object", () => {
    expectWaitAction(OBJECT);
  });

  it("reads a fenced object", () => {
    expectWaitAction(["```json", OBJECT, "```"].join("\n"));
  });

  it("reads an object behind prose without braces", () => {
    expectWaitAction(["Here is my decision for this step:", OBJECT].join("\n"));
  });

  it("reads an object behind prose holding a braced word", () => {
    expectWaitAction(
      ["The {Submit} button is visible in the form.", OBJECT].join("\n"),
    );
  });

  it("reads an object behind prose with an unclosed brace", () => {
    expectWaitAction(["Checking {the panel before I act:", OBJECT].join("\n"));
  });

  it("reads an object followed by prose holding a braced word", () => {
    expectWaitAction(
      [OBJECT, "Note: the target was the {Submit} button."].join("\n"),
    );
  });

  it("prefers a fenced answer over a JSON snippet quoted in the prose", () => {
    expectWaitAction(
      [
        'The status badge reads {"ok": true}.',
        "```json",
        OBJECT,
        "```",
      ].join("\n"),
    );
  });

  it("reads an unfenced object behind a JSON snippet quoted in the prose", () => {
    expectWaitAction(
      ['The status badge reads {"ok": true}.', OBJECT].join("\n"),
    );
  });

  it("still rejects a reply with no JSON object", () => {
    expect(() => parseBrainOutput("I cannot decide what to do.")).toThrow(
      BrainParseError,
    );
  });

  it("still rejects an object that fails schema validation behind prose", () => {
    const missingSummary = [
      "{",
      '  "target_display_id": 0,',
      '  "roi": [],',
      '  "proposed_action": { "kind": "wait", "rationale": "Loading." }',
      "}",
    ].join("\n");
    expect(() =>
      parseBrainOutput(
        ["The {Submit} button is visible.", missingSummary].join("\n"),
      ),
    ).toThrow(BrainParseError);
  });
});
