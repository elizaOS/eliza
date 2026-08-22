/**
 * Scanner evidence preservation coverage for complete, well-formed model context.
 */
import { describe, expect, it } from "vitest";
import { truncateEvidence } from "./types.ts";

describe("truncateEvidence", () => {
  it("preserves complete evidence beyond the retired scanner cap", () => {
    const evidence = `field: ${JSON.stringify("x".repeat(500))}`;
    expect(truncateEvidence(evidence, 120)).toBe(evidence);
  });

  it("does not reinterpret the legacy maxLen argument as a model-context cap", () => {
    const evidence = "complete scanner evidence";
    expect(truncateEvidence(evidence, 1)).toBe(evidence);
    expect(truncateEvidence(evidence, 0)).toBe(evidence);
    expect(truncateEvidence(evidence, -5)).toBe(evidence);
  });

  it("preserves empty and short evidence", () => {
    expect(truncateEvidence("", 120)).toBe("");
    expect(truncateEvidence("hi", 10)).toBe("hi");
  });

  it("preserves complete surrogate pairs across the former boundary", () => {
    const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
    const evidence = truncateEvidence(text, 120);
    expect(evidence).toBe(text);
    expect(evidence.isWellFormed()).toBe(true);
  });

  it("sanitizes lone surrogates without dropping surrounding evidence", () => {
    const text = `bad ${String.fromCharCode(0xd800)} evidence`;
    const evidence = truncateEvidence(text, 120);
    expect(evidence).toBe("bad \uFFFD evidence");
    expect(evidence.isWellFormed()).toBe(true);
  });
});
