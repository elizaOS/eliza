/**
 * @fileoverview Tolerant JSON parser tests for the LLM-judge layer.
 *
 * These cover the parse shapes Cerebras gpt-oss-120b is observed to emit even
 * with `response_format: {type: "json_object"}` set: strict JSON, fenced JSON,
 * leading prose + JSON, and trailing commentary after JSON. Garbage input must
 * surface as a clean null, never a thrown error.
 */

import { describe, expect, it } from "vitest";
import {
  extractJson,
  tolerantJsonParse,
} from "../src/judge/checks/llm-judge.ts";

describe("tolerantJsonParse", () => {
  it("parses strict JSON", () => {
    const parsed = tolerantJsonParse('{"verdict":"YES","reason":"clear"}');
    expect(parsed).toEqual({ verdict: "YES", reason: "clear" });
  });

  it("parses JSON inside a ```json fence", () => {
    const text = '```json\n{"verdict":"NO","reason":"violation"}\n```';
    expect(tolerantJsonParse(text)).toEqual({
      verdict: "NO",
      reason: "violation",
    });
  });

  it("parses JSON inside a bare ``` fence", () => {
    const text = '```\n{"verdict":"NEEDS_REVIEW","reason":"ambiguous"}\n```';
    expect(tolerantJsonParse(text)).toEqual({
      verdict: "NEEDS_REVIEW",
      reason: "ambiguous",
    });
  });

  it("parses JSON preceded by prose", () => {
    const text =
      'Here is the verdict:\n\n{"verdict":"YES","reason":"agent stayed silent"}';
    expect(tolerantJsonParse(text)).toEqual({
      verdict: "YES",
      reason: "agent stayed silent",
    });
  });

  it("parses JSON followed by trailing commentary", () => {
    const text =
      '{"verdict":"NO","reason":"agent kept talking"}\n\nLet me know if you want a longer review.';
    expect(tolerantJsonParse(text)).toEqual({
      verdict: "NO",
      reason: "agent kept talking",
    });
  });

  it("returns null on garbage input", () => {
    expect(tolerantJsonParse("not json at all")).toBeNull();
    expect(tolerantJsonParse("")).toBeNull();
    expect(tolerantJsonParse("{ broken")).toBeNull();
  });

  it("returns null for JSON arrays (we require an object)", () => {
    expect(tolerantJsonParse('["YES","clear"]')).toBeNull();
  });
});

describe("extractJson", () => {
  it("maps PASS-style verdicts to YES", () => {
    expect(extractJson('{"verdict":"PASS","reason":"r"}')).toEqual({
      verdict: "YES",
      reason: "r",
    });
  });

  it("maps FAIL-style verdicts to NO", () => {
    expect(extractJson('{"verdict":"FAIL","reason":"r"}')).toEqual({
      verdict: "NO",
      reason: "r",
    });
  });

  it("normalizes REVIEW -> NEEDS_REVIEW", () => {
    expect(extractJson('{"verdict":"REVIEW","reason":"r"}')).toEqual({
      verdict: "NEEDS_REVIEW",
      reason: "r",
    });
  });

  it("returns null for unknown verdict labels", () => {
    expect(extractJson('{"verdict":"MAYBE","reason":"r"}')).toBeNull();
  });

  it("extracts from fenced prose + trailing chatter", () => {
    const text = [
      "Sure — here's the verdict.",
      "```json",
      '{"verdict":"NO","reason":"told user to shut up but kept replying"}',
      "```",
      "Let me know if you want me to re-check.",
    ].join("\n");
    expect(extractJson(text)).toEqual({
      verdict: "NO",
      reason: "told user to shut up but kept replying",
    });
  });
});
