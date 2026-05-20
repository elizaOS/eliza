/**
 * User Identifier Classification Unit Tests
 * Tests for the shared package's user identifier classification utility
 */

import { describe, expect, it } from "bun:test";
import { resolveUserIdentifierKind } from "@feed/shared";

describe("resolveUserIdentifierKind", () => {
  it("should classify UUID as id", () => {
    expect(
      resolveUserIdentifierKind("550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("id");
    expect(
      resolveUserIdentifierKind("550E8400-E29B-41D4-A716-446655440000"),
    ).toBe("id"); // Case insensitive
  });

  it("should classify snowflake ID as id", () => {
    // Use a valid snowflake ID (15-19 digits)
    expect(resolveUserIdentifierKind("123456789012345")).toBe("id");
    expect(resolveUserIdentifierKind("12345678901234567")).toBe("id");
    expect(resolveUserIdentifierKind("1234567890123456789")).toBe("id");
  });

  it("should classify privy DID as privyId", () => {
    expect(resolveUserIdentifierKind("did:privy:abc123")).toBe("privyId");
    expect(resolveUserIdentifierKind("did:privy:xyz789")).toBe("privyId");
  });

  it("should classify username as username", () => {
    expect(resolveUserIdentifierKind("alice")).toBe("username");
    expect(resolveUserIdentifierKind("bob123")).toBe("username");
    expect(resolveUserIdentifierKind("user_name")).toBe("username");
  });

  it("should classify short numeric string as username (not snowflake)", () => {
    // Short numeric strings (3-14 digits) should be usernames, not IDs
    expect(resolveUserIdentifierKind("12345")).toBe("username");
    expect(resolveUserIdentifierKind("123")).toBe("username");
    expect(resolveUserIdentifierKind("12345678901234")).toBe("username"); // 14 digits
  });

  it("should handle edge cases", () => {
    // Empty string defaults to username
    expect(resolveUserIdentifierKind("")).toBe("username");
    // Special characters default to username
    expect(resolveUserIdentifierKind("user@example.com")).toBe("username");
  });
});
