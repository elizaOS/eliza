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

  it("accepts every supported version nibble (1-5)", () => {
    expect(isValidUUID("3d2f6a7e-9c1b-1e5a-8b2c-7d4e6f8091a2")).toBe(true); // v1
    expect(isValidUUID("3d2f6a7e-9c1b-2e5a-8b2c-7d4e6f8091a2")).toBe(true); // v2
    expect(isValidUUID("3d2f6a7e-9c1b-3e5a-8b2c-7d4e6f8091a2")).toBe(true); // v3
    expect(isValidUUID("3d2f6a7e-9c1b-5e5a-8b2c-7d4e6f8091a2")).toBe(true); // v5
  });

  it("rejects version nibbles outside 1-5, including real-world v6/v7", () => {
    expect(isValidUUID("3d2f6a7e-9c1b-6e5a-8b2c-7d4e6f8091a2")).toBe(false); // v6
    expect(isValidUUID("3d2f6a7e-9c1b-7e5a-8b2c-7d4e6f8091a2")).toBe(false); // v7
    expect(isValidUUID("3d2f6a7e-9c1b-8e5a-8b2c-7d4e6f8091a2")).toBe(false);
    expect(isValidUUID("3d2f6a7e-9c1b-fe5a-8b2c-7d4e6f8091a2")).toBe(false);
  });

  it("rejects every variant nibble outside 8/9/a/b", () => {
    expect(isValidUUID("550e8400-e29b-41d4-0716-446655440000")).toBe(false); // 0
    expect(isValidUUID("550e8400-e29b-41d4-d716-446655440000")).toBe(false); // d
    expect(isValidUUID("550e8400-e29b-41d4-e716-446655440000")).toBe(false); // e
    expect(isValidUUID("550e8400-e29b-41d4-f716-446655440000")).toBe(false); // f
  });

  it("rejects the nil UUID", () => {
    expect(isValidUUID("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("rejects wrong lengths and misplaced separators", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-4466554400000")).toBe(false); // too long
    expect(isValidUUID("550e8400e29b-41d4-a716-446655440000")).toBe(false); // missing first dash
    expect(isValidUUID("550e8400-e29b41d4-a716-446655440000")).toBe(false); // dash shifted
  });

  it("rejects non-hex characters in any group", () => {
    expect(isValidUUID("g50e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isValidUUID("550e8400-h29b-41d4-a716-446655440000")).toBe(false);
    expect(isValidUUID("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
  });

  it("accepts no wrapping, prefix, or padding — strict syntactic gate", () => {
    expect(isValidUUID("{550e8400-e29b-41d4-a716-446655440000}")).toBe(false);
    expect(isValidUUID("urn:uuid:550e8400-e29b-41d4-a716-446655440000")).toBe(
      false,
    );
    expect(isValidUUID(" 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });
});
