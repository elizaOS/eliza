/** Unit tests for the action-result and parameter-reader helpers. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { FAILURE_TEXT_PREFIX, type ToolFailure } from "../types.js";
import {
  capTranscriptForChat,
  failureToActionResult,
  fencePreformatted,
  readArrayParam,
  readBoolParam,
  readBoundedIntSetting,
  readNumberParam,
  readParam,
  readPositiveIntSetting,
  readStringParam,
  successActionResult,
  truncate,
  userFacingSuccessResult,
} from "./format.js";

/** Pure param-reading + ActionResult formatting helpers for the coding tools. */

describe("ActionResult builders", () => {
  it("failureToActionResult carries prefix, reason, message, and an Error", () => {
    const failure: ToolFailure = {
      reason: "bad_input",
      message: "nope",
    } as ToolFailure;
    const r = failureToActionResult(failure, { x: 1 });
    expect(r.success).toBe(false);
    expect(r.text).toBe(`${FAILURE_TEXT_PREFIX} bad_input: nope`);
    expect(r.error).toBeInstanceOf(Error);
    expect((r.error as Error).message).toBe(r.text);
    expect(r.data).toEqual({ x: 1 });
  });

  it("successActionResult is success with optional data", () => {
    expect(successActionResult("ok")).toMatchObject({
      success: true,
      text: "ok",
    });
    expect(successActionResult("ok", { a: 2 }).data).toEqual({ a: 2 });
    expect(successActionResult("ok").data).toBeUndefined();
  });

  it("userFacingSuccessResult marks the text user-facing (relay opt-in)", () => {
    const r = userFacingSuccessResult("Wrote 3 bytes to /tmp/x", { bytes: 3 });
    expect(r.success).toBe(true);
    expect(r.text).toBe("Wrote 3 bytes to /tmp/x");
    expect(r.userFacingText).toBe("Wrote 3 bytes to /tmp/x");
    // verifiedUserFacing stays unset so the evaluator's messageToUser still wins
    // the happy path — only the failure relay reads userFacingText.
    expect(r.verifiedUserFacing).toBeUndefined();
    expect(r.data).toEqual({ bytes: 3 });
  });
});

describe("readParam family", () => {
  const opts = { parameters: { p: "fromParams" }, top: "fromTop" };

  it("prefers parameters[name], then the top-level key", () => {
    expect(readParam(opts, "p")).toBe("fromParams");
    expect(readParam(opts, "top")).toBe("fromTop");
    expect(readParam(opts, "missing")).toBeUndefined();
    expect(readParam(null, "p")).toBeUndefined();
    expect(readParam("str", "p")).toBeUndefined();
  });

  it("readStringParam returns only strings", () => {
    expect(readStringParam({ parameters: { s: "hi" } }, "s")).toBe("hi");
    expect(readStringParam({ parameters: { s: 5 } }, "s")).toBeUndefined();
  });

  it("readNumberParam coerces numeric strings", () => {
    expect(readNumberParam({ n: 7 }, "n")).toBe(7);
    expect(readNumberParam({ n: "7.5" }, "n")).toBe(7.5);
    expect(readNumberParam({ n: "x" }, "n")).toBeUndefined();
    expect(readNumberParam({ n: Number.NaN }, "n")).toBeUndefined();
  });

  it("readBoolParam accepts the documented truthy/falsy forms", () => {
    for (const v of [true, "true", "1", 1]) {
      expect(readBoolParam({ b: v }, "b")).toBe(true);
    }
    for (const v of [false, "false", "0", 0]) {
      expect(readBoolParam({ b: v }, "b")).toBe(false);
    }
    expect(readBoolParam({ b: "maybe" }, "b")).toBeUndefined();
  });

  it("readArrayParam returns only arrays", () => {
    expect(readArrayParam({ a: [1, 2] }, "a")).toEqual([1, 2]);
    expect(readArrayParam({ a: "no" }, "a")).toBeUndefined();
  });
});

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false });
  });
  it("truncates with a remaining-chars suffix", () => {
    const r = truncate("abcdefghij", 4);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("abcd")).toBe(true);
    expect(r.text).toContain("6 more chars");
  });
  it("keeps UTF-16 surrogate pairs intact at the truncation boundary", () => {
    const s = `${"a".repeat(9)}🦊${"b".repeat(100)}`;
    const r = truncate(s, 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a".repeat(9))).toBe(true);
    expect(r.text.split("\n")[0].isWellFormed()).toBe(true);
    expect(r.text.split("\n")[0].length).toBe(9);
    expect(r.text).toContain("102 more chars");
  });
  it("preserves a fitting emoji under the cap", () => {
    const s = `${"a".repeat(8)}🦊`;
    const r = truncate(s, 10);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(s);
    expect(r.text.isWellFormed()).toBe(true);
  });
  it("sanitizes lone surrogates before truncating", () => {
    const s = "a\ud800bcdef";
    const r = truncate(s, 4);
    expect(r.text.split("\n")[0]).toBe("a\ufffdbc");
    expect(r.text.split("\n")[0].isWellFormed()).toBe(true);
  });
  it("sanitizes lone surrogates without truncation when under the cap", () => {
    const s = "a\ud800bc";
    const r = truncate(s, 10);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("a\ufffdbc");
    expect(r.text.isWellFormed()).toBe(true);
  });
  it("returns empty well-formed text when max is 0", () => {
    const r = truncate("hello", 0);
    expect(r.truncated).toBe(true);
    expect(r.text.split("\n")[0]).toBe("");
    expect(r.text.split("\n")[0].isWellFormed()).toBe(true);
  });
});

describe("readPositiveIntSetting", () => {
  const rt = (value: unknown): IAgentRuntime =>
    ({ getSetting: () => value }) as unknown as IAgentRuntime;

  it("reads positive numbers / numeric strings, flooring", () => {
    expect(readPositiveIntSetting(rt(5), "k", 1)).toBe(5);
    expect(readPositiveIntSetting(rt(5.9), "k", 1)).toBe(5);
    expect(readPositiveIntSetting(rt("8"), "k", 1)).toBe(8);
  });

  it("falls back for missing / invalid / non-positive values", () => {
    expect(readPositiveIntSetting(rt(undefined), "k", 3)).toBe(3);
    expect(readPositiveIntSetting(rt(0), "k", 3)).toBe(3);
    expect(readPositiveIntSetting(rt(-2), "k", 3)).toBe(3);
    expect(readPositiveIntSetting(rt("nope"), "k", 3)).toBe(3);
  });
});

describe("readBoundedIntSetting", () => {
  const rt = (value: unknown): IAgentRuntime =>
    ({ getSetting: () => value }) as unknown as IAgentRuntime;

  it("accepts omitted, canonical integer, and numeric settings in range", () => {
    expect(
      readBoundedIntSetting(rt(undefined), "k", 100, 600_000, {}),
    ).toBeUndefined();
    expect(
      readBoundedIntSetting(rt(null), "k", 100, 600_000, {}),
    ).toBeUndefined();
    expect(readBoundedIntSetting(rt("200"), "k", 100, 600_000, {})).toEqual({
      value: 200,
    });
    expect(readBoundedIntSetting(rt(600_000), "k", 100, 600_000, {})).toEqual({
      value: 600_000,
    });
  });

  it("reads the environment only on runtime omission", () => {
    expect(
      readBoundedIntSetting(rt(null), "k", 100, 600_000, { k: "200" }),
    ).toEqual({ value: 200 });
    expect(
      readBoundedIntSetting(rt("300"), "k", 100, 600_000, { k: "200" }),
    ).toEqual({ value: 300 });
    expect(
      readBoundedIntSetting(rt(""), "k", 100, 600_000, { k: "200" }),
    ).toEqual({
      error: "k must be a canonical decimal integer between 100 and 600000.",
    });
  });

  it.each([
    "",
    "45.5",
    "1e3",
    " 200",
    "0200",
    "9007199254740992",
    "oops",
    45.5,
    0,
    600_001,
    false,
    {},
    Symbol("timeout"),
  ])("rejects invalid operator settings: %j", (value) => {
    expect(
      readBoundedIntSetting(
        rt(value),
        "CODING_TOOLS_SHELL_TIMEOUT_MS",
        100,
        600_000,
        {},
      ),
    ).toEqual({
      error:
        "CODING_TOOLS_SHELL_TIMEOUT_MS must be a canonical decimal integer between 100 and 600000.",
    });
  });

  it.each(["", "45.5", " 200", "600001"])(
    "rejects invalid environment settings: %j",
    (value) => {
      expect(
        readBoundedIntSetting(rt(null), "k", 100, 600_000, { k: value }),
      ).toEqual({
        error: "k must be a canonical decimal integer between 100 and 600000.",
      });
    },
  );
});

describe("fencePreformatted", () => {
  it("wraps plain transcripts in a three-backtick fence with a trailing newline", () => {
    expect(fencePreformatted('$ find . -name "*.md"\nok')).toBe(
      '```\n$ find . -name "*.md"\nok\n```',
    );
  });

  it("preserves markdown metacharacters verbatim inside the fence", () => {
    const text = "*.md and _under_ and **bold**";
    expect(fencePreformatted(text)).toContain(text);
  });

  it("grows the fence past the longest embedded backtick run", () => {
    const text = "docs say ```js\ncode\n``` is a fence";
    const fenced = fencePreformatted(text);
    expect(fenced.startsWith("````\n")).toBe(true);
    expect(fenced.endsWith("````")).toBe(true);
  });

  it("does not double a trailing newline", () => {
    expect(fencePreformatted("line\n")).toBe("```\nline\n```");
  });
});

describe("capTranscriptForChat", () => {
  it("passes short transcripts through untouched", () => {
    const text = "$ ls\n[exit 0]\nfile-a\nfile-b";
    expect(capTranscriptForChat(text)).toBe(text);
  });

  it("caps long transcripts with head, tail, and an elision marker", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i}`);
    const text = lines.join("\n");
    const capped = capTranscriptForChat(text, 1500);
    expect(capped.length).toBeLessThan(1700);
    expect(capped).toContain("line-0");
    expect(capped).toContain("line-399");
    expect(capped).toMatch(/\[\d+ lines omitted — ask to see more\]/);
  });

  it("keeps head and tail on line boundaries", () => {
    const text = Array.from({ length: 300 }, (_, i) => `row ${i} content`).join(
      "\n",
    );
    const capped = capTranscriptForChat(text, 1000);
    const [head] = capped.split("\n… [");
    expect(head.endsWith("content")).toBe(true);
  });
});
