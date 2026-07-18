/** Unit tests for the action-result and parameter-reader helpers. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { FAILURE_TEXT_PREFIX, type ToolFailure } from "../types.js";
import {
  failureToActionResult,
  fencePreformatted,
  readArrayParam,
  readBoolParam,
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
