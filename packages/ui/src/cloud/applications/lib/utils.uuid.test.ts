/**
 * Unit coverage pinning the isValidUUID v1-v5 syntactic contract the app/deploy
 * routes key on (#9145). Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import { isValidUUID } from "./utils.js";

// #9145 — app/deploy routes key on UUIDs; isValidUUID is the syntactic gate and
// was untested. Pin the v1-v5 contract (version digit 1-5, variant 8/9/a/b).
describe("isValidUUID", () => {
  it("accepts a well-formed v4 UUID (any case)", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidUUID("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects wrong version/variant nibbles", () => {
    // version 0 (must be 1-5)
    expect(isValidUUID("550e8400-e29b-01d4-a716-446655440000")).toBe(false);
    // variant 'c' (must be 8/9/a/b)
    expect(isValidUUID("550e8400-e29b-41d4-c716-446655440000")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("550e8400e29b41d4a716446655440000")).toBe(false); // no dashes
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("550e8400-e29b-41d4-a716-44665544000")).toBe(false); // too short
  });
});
