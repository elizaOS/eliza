// Exercises cron behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import { timingSafeEqualSecret } from "./cron";

describe("timingSafeEqualSecret", () => {
  it("returns true only for an exact match", () => {
    expect(timingSafeEqualSecret("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(timingSafeEqualSecret("s3cr3t-token", "s3cr3t-tokeX")).toBe(false);
    // a one-character difference at the start must not short-circuit to true
    expect(timingSafeEqualSecret("Xs3cr3t-toke", "s3cr3t-tokeX")).toBe(false);
  });

  it("returns false on any length mismatch (no prefix match)", () => {
    expect(timingSafeEqualSecret("secret", "secretpadding")).toBe(false);
    expect(timingSafeEqualSecret("secretpadding", "secret")).toBe(false);
    // an empty provided value never matches a configured secret
    expect(timingSafeEqualSecret("", "secret")).toBe(false);
  });

  it("handles unicode/byte-length differences", () => {
    // "é" is two UTF-8 bytes; the buffers differ in length from the ascii form
    expect(timingSafeEqualSecret("café", "cafe")).toBe(false);
    expect(timingSafeEqualSecret("café", "café")).toBe(true);
  });
});
