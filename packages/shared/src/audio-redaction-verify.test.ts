/**
 * Coverage for audio-redaction-verify.
 */
import { describe, expect, it } from "vitest";
import {
  findMissingSentinels,
  findResidualPii,
} from "./audio-redaction-verify.js";

describe("audio-redaction-verify", () => {
  it("finds residual PII by normalized containment", () => {
    const found = findResidualPii("call me at 555 0123 today", [
      "5550123",
      "unlisted",
    ]);
    expect(found).toEqual(["5550123"]);
  });

  it("returns empty when no PII remains", () => {
    const found = findResidualPii("all clear", ["secret", "5550123"]);
    expect(found).toEqual([]);
  });

  it("ignores empty needles", () => {
    const found = findResidualPii("text", ["", "  "]);
    expect(found).toEqual([]);
  });

  it("finds missing sentinels (normalized)", () => {
    const missing = findMissingSentinels("the redacted transcript body", [
      "body",
      "missing-sentinel",
    ]);
    expect(missing).toEqual(["missing-sentinel"]);
  });

  it("returns all sentinels when transcript is empty", () => {
    const missing = findMissingSentinels("", ["a", "b"]);
    expect(missing).toEqual(["a", "b"]);
  });
});
