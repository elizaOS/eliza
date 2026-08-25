/**
 * Covers Google Chat resource-name validation and normalization helpers.
 * Pins the regex contracts for space/user names and the target-to-resource
 * coercion so malformed inputs never reach the Google Chat API.
 */
import { describe, expect, it } from "vitest";

import {
  extractResourceId,
  getSpaceDisplayName,
  getUserDisplayName,
  isDirectMessage,
  isValidGoogleChatSpaceName,
  isValidGoogleChatUserName,
  normalizeSpaceTarget,
  normalizeUserTarget,
} from "./types";

describe("isValidGoogleChatSpaceName", () => {
  it("accepts canonical space names", () => {
    expect(isValidGoogleChatSpaceName("spaces/abc123")).toBe(true);
    expect(isValidGoogleChatSpaceName("spaces/ABC-123_def")).toBe(true);
    expect(isValidGoogleChatSpaceName("spaces/1")).toBe(true);
  });

  it("rejects malformed space names", () => {
    expect(isValidGoogleChatSpaceName("")).toBe(false);
    expect(isValidGoogleChatSpaceName("spaces/")).toBe(false);
    expect(isValidGoogleChatSpaceName("space/abc")).toBe(false);
    expect(isValidGoogleChatSpaceName("spaces/abc/def")).toBe(false);
    expect(isValidGoogleChatSpaceName("spaces/abc def")).toBe(false);
    expect(isValidGoogleChatSpaceName("spaces/")).toBe(false);
    expect(isValidGoogleChatSpaceName(" spaces/abc")).toBe(false);
  });
});

describe("isValidGoogleChatUserName", () => {
  it("accepts canonical user names", () => {
    expect(isValidGoogleChatUserName("users/abc123")).toBe(true);
    expect(isValidGoogleChatUserName("users/XYZ-789_def")).toBe(true);
  });

  it("rejects malformed user names", () => {
    expect(isValidGoogleChatUserName("")).toBe(false);
    expect(isValidGoogleChatUserName("users/")).toBe(false);
    expect(isValidGoogleChatUserName("user/abc")).toBe(false);
    expect(isValidGoogleChatUserName("users/abc/def")).toBe(false);
    expect(isValidGoogleChatUserName("users/abc def")).toBe(false);
  });
});

describe("normalizeSpaceTarget", () => {
  it("returns already-canonical names unchanged", () => {
    expect(normalizeSpaceTarget("spaces/abc123")).toBe("spaces/abc123");
    expect(normalizeSpaceTarget("  spaces/abc123  ")).toBe("spaces/abc123");
  });

  it("coerces bare IDs to canonical form", () => {
    expect(normalizeSpaceTarget("abc123")).toBe("spaces/abc123");
    expect(normalizeSpaceTarget("  abc123  ")).toBe("spaces/abc123");
    expect(normalizeSpaceTarget("ABC-123_def")).toBe("spaces/ABC-123_def");
  });

  it("rejects blank and malformed inputs", () => {
    expect(normalizeSpaceTarget("")).toBeNull();
    expect(normalizeSpaceTarget("   ")).toBeNull();
    expect(normalizeSpaceTarget("spaces/abc def")).toBeNull();
    expect(normalizeSpaceTarget("spaces/")).toBeNull();
    expect(normalizeSpaceTarget("spaces/abc/def")).toBeNull();
  });
});

describe("normalizeUserTarget", () => {
  it("returns already-canonical user names unchanged", () => {
    expect(normalizeUserTarget("users/abc123")).toBe("users/abc123");
    expect(normalizeUserTarget("  users/abc123  ")).toBe("users/abc123");
  });

  it("coerces bare IDs to canonical form", () => {
    expect(normalizeUserTarget("abc123")).toBe("users/abc123");
    expect(normalizeUserTarget("XYZ-789")).toBe("users/XYZ-789");
  });

  it("rejects blank and malformed inputs", () => {
    expect(normalizeUserTarget("")).toBeNull();
    expect(normalizeUserTarget("   ")).toBeNull();
    expect(normalizeUserTarget("users/abc def")).toBeNull();
    expect(normalizeUserTarget("users/")).toBeNull();
  });
});

describe("extractResourceId", () => {
  it("returns the trailing segment after the last slash", () => {
    expect(extractResourceId("spaces/abc123")).toBe("abc123");
    expect(extractResourceId("users/xyz")).toBe("xyz");
    expect(extractResourceId("spaces/a/b/c")).toBe("c");
    expect(extractResourceId("single")).toBe("single");
  });
});

describe("getUserDisplayName / getSpaceDisplayName", () => {
  it("prefers displayName when present", () => {
    expect(getUserDisplayName({ name: "users/123", displayName: "Alice" } as never)).toBe("Alice");
    expect(getSpaceDisplayName({ name: "spaces/123", displayName: "General" } as never)).toBe(
      "General"
    );
  });

  it("falls back to resource ID when displayName is missing", () => {
    expect(getUserDisplayName({ name: "users/123" } as never)).toBe("123");
    expect(getSpaceDisplayName({ name: "spaces/abc" } as never)).toBe("abc");
  });
});

describe("isDirectMessage", () => {
  it("detects DM by type and singleUserBotDm", () => {
    expect(isDirectMessage({ type: "DM" } as never)).toBe(true);
    expect(isDirectMessage({ type: "ROOM", singleUserBotDm: true } as never)).toBe(true);
    expect(isDirectMessage({ type: "ROOM" } as never)).toBe(false);
    expect(isDirectMessage({ type: "SPACE" } as never)).toBe(false);
  });
});
