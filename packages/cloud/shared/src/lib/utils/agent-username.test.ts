// Exercises agent username behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  extractUsernameFromPath,
  generateUniqueUsername,
  generateUsernameFromName,
  RESERVED_USERNAMES,
  slugify,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateUsername,
} from "./agent-username";

/**
 * Agent usernames are used for URL routing (/chat/@username). Validation must
 * enforce length/charset/hyphen rules and reject reserved names; slugify must
 * produce a safe slug; uniqueness must avoid collisions; and path extraction
 * must only accept the canonical shape — a loose check here enables routing
 * spoofing or collisions.
 */

describe("validateUsername", () => {
  test("rejects bad length / charset / hyphen placement", () => {
    expect(validateUsername("ab").valid).toBe(false);
    expect(validateUsername("a".repeat(31)).valid).toBe(false);
    expect(validateUsername("-bad").error).toMatch(/start or end with a hyphen/);
    expect(validateUsername("bad-").error).toMatch(/start or end with a hyphen/);
    expect(validateUsername("a--b").error).toMatch(/consecutive hyphens/);
    expect(validateUsername("Bad Name!").valid).toBe(false);
  });

  test("rejects reserved names, accepts + normalizes valid ones", () => {
    const reserved = [...RESERVED_USERNAMES][0];
    expect(validateUsername(reserved).error).toMatch(/reserved/);
    const ok = validateUsername("Cool-Agent");
    expect(ok.valid).toBe(true);
    expect(ok.normalized).toBe("cool-agent");
  });

  /**
   * The assertion above reads the set's first element, so it holds for any
   * non-empty set and cannot notice an entry leaving the list. Every reserved
   * name is a real top-level surface (`/chat/@admin`, `@login`, `@settings`),
   * and an entry that quietly disappears becomes a handle anyone can claim.
   * Pin the membership itself, then the behaviour of each entry.
   */
  test("reserves exactly the documented set of route names", () => {
    expect([...RESERVED_USERNAMES].sort()).toEqual([
      "admin",
      "api",
      "app",
      "chat",
      "dashboard",
      "eliza",
      "elizaos",
      "help",
      "login",
      "logout",
      "me",
      "new",
      "null",
      "profile",
      "settings",
      "signup",
      "support",
      "system",
      "undefined",
      "user",
      "www",
    ]);
    for (const reserved of RESERVED_USERNAMES) {
      // An entry stored with a capital could never match `normalized`, so it
      // would read as protection while being dead weight.
      expect(reserved).toBe(reserved.toLowerCase());
    }
  });

  test.each([...RESERVED_USERNAMES])("refuses %s by name", (reserved) => {
    const result = validateUsername(reserved);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeUndefined();
    // `me` is two characters, so the length check answers first and the
    // reserved branch is unreachable for it through this entry point. It still
    // does work: CharactersService seeds `RESERVED_USERNAMES` into the taken-name
    // set when generating, so it blocks a collision there.
    expect(result.error).toMatch(reserved.length < USERNAME_MIN_LENGTH ? /at least/ : /reserved/);
  });

  test("the reserved check is case-folded, not raw", () => {
    // The guard reads `normalized`, not the caller's string. Reading the raw
    // input instead leaves the whole list bypassable by shifting one character:
    // `Admin` would come back `{ valid: true, normalized: "admin" }` and take
    // the `/chat/@admin` route. Nothing above distinguishes the two reads.
    const reachable = [...RESERVED_USERNAMES].filter((name) => name.length >= USERNAME_MIN_LENGTH);
    expect(reachable.length).toBeGreaterThan(0);
    for (const reserved of reachable) {
      for (const spelling of [
        reserved.toUpperCase(),
        reserved[0].toUpperCase() + reserved.slice(1),
      ]) {
        const result = validateUsername(spelling);
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/reserved/);
        expect(result.normalized).toBeUndefined();
      }
    }
  });
});

describe("slugify", () => {
  test("produces URL-safe slugs", () => {
    expect(slugify("My Cool Agent")).toBe("my-cool-agent");
    expect(slugify("Agent #1 (Test)")).toBe("agent-1-test");
    expect(slugify("___Test---Agent___")).toBe("test-agent");
  });
});

describe("generateUsernameFromName", () => {
  test("slugs and truncates to the max length", () => {
    expect(generateUsernameFromName("My Cool Agent")).toBe("my-cool-agent");
    expect(generateUsernameFromName("a".repeat(40)).length).toBeLessThanOrEqual(
      USERNAME_MAX_LENGTH,
    );
  });
});

describe("generateUniqueUsername", () => {
  test("appends an incrementing suffix on collision", () => {
    expect(generateUniqueUsername("cool-agent", new Set())).toBe("cool-agent");
    expect(generateUniqueUsername("cool-agent", new Set(["cool-agent"]))).toBe("cool-agent-2");
    expect(generateUniqueUsername("cool-agent", new Set(["cool-agent", "cool-agent-2"]))).toBe(
      "cool-agent-3",
    );
  });
});

describe("extractUsernameFromPath", () => {
  test("extracts the @handle, else null", () => {
    expect(extractUsernameFromPath("/chat/@cool-agent")).toBe("cool-agent");
    expect(extractUsernameFromPath("/chat/@bob/extra")).toBe("bob");
    expect(extractUsernameFromPath("/other/path")).toBeNull();
  });
});
