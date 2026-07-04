/**
 * Verifies extractShortToolDeliverable.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { extractShortToolDeliverable } from "../services/sub-agent-router";

const wrap = (body: string, title = "bash") =>
  `[tool output: ${title}]\n${body}\n[/tool output]`;

describe("extractShortToolDeliverable", () => {
  it("recovers the inner body of a single short tool-output block from response", () => {
    expect(
      extractShortToolDeliverable({ response: `prose\n${wrap("2026-06-02")}` }),
    ).toBe("2026-06-02");
  });

  it("falls back to finalText when response is absent", () => {
    expect(extractShortToolDeliverable({ finalText: wrap("70234") })).toBe(
      "70234",
    );
  });

  it("returns the LAST block when there are multiple (final result wins)", () => {
    expect(
      extractShortToolDeliverable({
        response: `${wrap("first")}\n${wrap("second")}`,
      }),
    ).toBe("second");
  });

  it("recovers the successful retry's output past a failed first attempt", () => {
    // `python` not found, then `python3` succeeds — the real factorial bug.
    expect(
      extractShortToolDeliverable({
        response: `${wrap("/usr/bin/bash: line 1: python: command not found")}${wrap("479001600")}479`,
      }),
    ).toBe("479001600");
  });

  it("skips a trailing empty block and returns the last non-empty one", () => {
    expect(
      extractShortToolDeliverable({
        response: `${wrap("479001600")}\n${wrap("")}`,
      }),
    ).toBe("479001600");
  });

  it("returns undefined when the last block exceeds the size cap", () => {
    const big = "a".repeat(2049);
    expect(
      extractShortToolDeliverable({
        response: `${wrap("small")}\n${wrap(big)}`,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when there is no tool-output block", () => {
    expect(
      extractShortToolDeliverable({ response: "just prose, no envelope" }),
    ).toBeUndefined();
  });

  it("relays a body exactly at the 2048-byte boundary", () => {
    const body = "a".repeat(2048);
    expect(extractShortToolDeliverable({ response: wrap(body) })).toBe(body);
  });

  it("returns undefined for a body over the 2048-byte cap", () => {
    const body = "a".repeat(2049);
    expect(
      extractShortToolDeliverable({ response: wrap(body) }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty body", () => {
    expect(extractShortToolDeliverable({ response: wrap("") })).toBeUndefined();
  });

  it("returns undefined for missing/invalid payload", () => {
    expect(extractShortToolDeliverable(undefined)).toBeUndefined();
    expect(extractShortToolDeliverable({})).toBeUndefined();
    expect(extractShortToolDeliverable("not an object")).toBeUndefined();
  });
});
