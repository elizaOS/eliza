/**
 * Verifies complete tool-deliverable extraction.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractToolDeliverables } from "../services/sub-agent-router";

const wrap = (body: string, title = "bash") =>
  `[tool output: ${title}]\n${body}\n[/tool output]`;

describe("extractToolDeliverables", () => {
  it("recovers the inner body of a single short tool-output block from response", () => {
    expect(
      extractToolDeliverables({ response: `prose\n${wrap("2026-06-02")}` }),
    ).toBe("2026-06-02");
  });

  it("falls back to finalText when response is absent", () => {
    expect(extractToolDeliverables({ finalText: wrap("70234") })).toBe("70234");
  });

  it("preserves every block when there are multiple", () => {
    expect(
      extractToolDeliverables({
        response: `${wrap("first")}\n${wrap("second")}`,
      }),
    ).toBe("first\nsecond");
  });

  it("recovers the successful retry's output past a failed first attempt", () => {
    // `python` not found, then `python3` succeeds — the real factorial bug.
    expect(
      extractToolDeliverables({
        response: `${wrap("/usr/bin/bash: line 1: python: command not found")}${wrap("479001600")}479`,
      }),
    ).toBe("/usr/bin/bash: line 1: python: command not found\n479001600");
  });

  it("skips a trailing empty block and returns the last non-empty one", () => {
    expect(
      extractToolDeliverables({
        response: `${wrap("479001600")}\n${wrap("")}`,
      }),
    ).toBe("479001600");
  });

  it("preserves every block beyond the former size cap", () => {
    const big = "a".repeat(2049);
    expect(
      extractToolDeliverables({
        response: `${wrap("small")}\n${wrap(big)}`,
      }),
    ).toBe(`small\n${big}`);
  });

  it("returns undefined when there is no tool-output block", () => {
    expect(
      extractToolDeliverables({ response: "just prose, no envelope" }),
    ).toBeUndefined();
  });

  it("relays a body exactly at the 2048-byte boundary", () => {
    const body = "a".repeat(2048);
    expect(extractToolDeliverables({ response: wrap(body) })).toBe(body);
  });

  it("preserves a body over the former 2048-byte cap", () => {
    const body = "a".repeat(2049);
    expect(extractToolDeliverables({ response: wrap(body) })).toBe(body);
  });

  it("returns undefined for an empty body", () => {
    expect(extractToolDeliverables({ response: wrap("") })).toBeUndefined();
  });

  it("returns undefined for missing/invalid payload", () => {
    expect(extractToolDeliverables(undefined)).toBeUndefined();
    expect(extractToolDeliverables({})).toBeUndefined();
    expect(extractToolDeliverables("not an object")).toBeUndefined();
  });
});
