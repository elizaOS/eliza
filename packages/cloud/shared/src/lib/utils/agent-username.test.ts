// Exercises agent username behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  extractUsernameFromPath,
  generateUniqueUsername,
  generateUsernameFromName,
  RESERVED_USERNAMES,
  slugify,
  USERNAME_MAX_LENGTH,
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

describe("non-string guards", () => {
  test("validateUsername rejects non-string without throwing", () => {
    // @ts-expect-error runtime guard check
    expect(validateUsername(null).valid).toBe(false);
    // @ts-expect-error runtime guard check
    expect(validateUsername(undefined).valid).toBe(false);
    // @ts-expect-error runtime guard check
    expect(validateUsername(123).valid).toBe(false);
    // @ts-expect-error runtime guard check
    expect(validateUsername({}).valid).toBe(false);
    // @ts-expect-error runtime guard check
    expect(validateUsername([]).valid).toBe(false);
    // @ts-expect-error runtime guard check
    expect(validateUsername(true).valid).toBe(false);
  });

  test("slugify and generate helpers return safe defaults for non-string", () => {
    // @ts-expect-error runtime guard check
    expect(slugify(null)).toBe("");
    // @ts-expect-error runtime guard check
    expect(slugify(undefined)).toBe("");
    // @ts-expect-error runtime guard check
    expect(slugify(123)).toBe("");
    // @ts-expect-error runtime guard check
    expect(slugify({})).toBe("");
    // @ts-expect-error runtime guard check
    expect(generateUsernameFromName(null).length).toBeGreaterThanOrEqual(3);
    // @ts-expect-error runtime guard check
    expect(generateUsernameFromName(undefined).length).toBeGreaterThanOrEqual(3);
    // @ts-expect-error runtime guard check
    expect(generateUsernameFromName(123).length).toBeGreaterThanOrEqual(3);
    // @ts-expect-error runtime guard check
    expect(generateUniqueUsername(null, new Set())).toBeDefined();
    // @ts-expect-error runtime guard check
    expect(generateUniqueUsername(undefined, new Set())).toBeDefined();
    // @ts-expect-error runtime guard check
    expect(extractUsernameFromPath(null)).toBeNull();
    // @ts-expect-error runtime guard check
    expect(extractUsernameFromPath(undefined)).toBeNull();
    // @ts-expect-error runtime guard check
    expect(extractUsernameFromPath(123)).toBeNull();
    // @ts-expect-error runtime guard check
    expect(extractUsernameFromPath({})).toBeNull();
  });
});
