/**
 * Derivation and normalization rules for the frozen `preferred_username`.
 * Pure functions only — the allocate-and-freeze path against a real unique
 * index is exercised by the PGlite-backed provider suite in cloud-api.
 *
 * These rules are a one-way door: the relying party turns the value into a
 * permanent account name, so an unusable or squattable candidate has to be
 * rejected here rather than discovered in production.
 */

import { describe, expect, test } from "bun:test";

import { deriveUsernameCandidates, normalizeUsernameCandidate } from "./username-policy";

describe("normalization", () => {
  test("lowercases and keeps the safe character set", () => {
    expect(normalizeUsernameCandidate("Ada_Lovelace-1")).toBe("ada_lovelace-1");
  });

  test("a dot becomes a dash, because Forgejo reserves whole dotted suffixes", () => {
    // `*.keys`, `*.gpg`, `*.rss`, `*.atom` and `*.png` are refused by
    // Forgejo's reservedUserPatterns. The name is frozen before the relying
    // party ever sees it, so one of those would lock the user out for good.
    expect(normalizeUsernameCandidate("Ada.Lovelace")).toBe("ada-lovelace");
    for (const raw of ["ada.keys", "ada.gpg", "ada.rss", "ada.atom", "ada.png"]) {
      const value = normalizeUsernameCandidate(raw) as string;
      expect(value).not.toContain(".");
      expect(value).toBe(`ada-${raw.split(".")[1]}`);
    }
  });

  test("the result satisfies Forgejo's own username validator", () => {
    // models/user/user.go: validUsernamePattern minus invalidUsernamePattern.
    const valid = /^[\da-zA-Z][-.\w]*$/;
    const invalid = /[-._]{2,}|[-._]$/;
    for (const raw of [
      "Ada.Lovelace",
      "ada..lovelace",
      "ada__lovelace",
      "ada._-lovelace",
      "ada.",
      "ada-",
      "ada_",
      "Ada 🦋 the Countess",
      `${"a".repeat(31)}.bcdefg`,
    ]) {
      const value = normalizeUsernameCandidate(raw);
      if (value === null) continue;
      expect(valid.test(value)).toBe(true);
      expect(invalid.test(value)).toBe(false);
    }
  });

  test("folds accents to their ASCII base rather than dropping the letter", () => {
    expect(normalizeUsernameCandidate("José")).toBe("jose");
  });

  test("replaces unsafe characters and collapses the runs they leave behind", () => {
    expect(normalizeUsernameCandidate("Ada 🦋 the Countess")).toBe("ada-the-countess");
    expect(normalizeUsernameCandidate("a//////b")).toBe("a-b");
  });

  test("trims leading and trailing separators so the value is URL-safe", () => {
    expect(normalizeUsernameCandidate("--ada--")).toBe("ada");
    expect(normalizeUsernameCandidate("...ada...")).toBe("ada");
  });

  test("truncates to 32 characters without leaving a trailing separator", () => {
    const value = normalizeUsernameCandidate(`${"a".repeat(31)}-bcdefg`);
    expect(value).toBe("a".repeat(31));
    expect((value as string).length).toBeLessThanOrEqual(32);
  });

  test("rejects candidates that cannot be a username", () => {
    for (const raw of [null, undefined, "", " ", "a", "🦋", "----", "___"]) {
      expect(normalizeUsernameCandidate(raw)).toBeNull();
    }
  });

  test("rejects a value that would not start with an alphanumeric", () => {
    // A leading separator survives only if the whole string is separators,
    // which is already rejected; this pins the explicit guard.
    expect(normalizeUsernameCandidate("_")).toBeNull();
  });

  test("refuses to let an SSO user squat an operational or reserved name", () => {
    for (const reserved of [
      "admin",
      "Admin",
      "eliza-merge-steward",
      "forgejo",
      "explore",
      "api",
      "oauth",
      "well-known",
    ]) {
      expect(normalizeUsernameCandidate(reserved)).toBeNull();
    }
  });

  test("refuses the names Forgejo itself reserves, which it would refuse to create", () => {
    for (const reserved of [
      "assets",
      "attachments",
      "avatar",
      "avatars",
      "captcha",
      "commits",
      "debug",
      "devtest",
      "error",
      "ghost",
      "issues",
      "login",
      "metrics",
      "milestones",
      "new",
      "notifications",
      "org",
      "pulls",
      "raw",
      "repo",
      "repo-avatars",
      "search",
      "ssh_info",
      "user",
      "v2",
      "gitea-actions",
      "forgejo-actions",
    ]) {
      expect(normalizeUsernameCandidate(reserved)).toBeNull();
    }
  });
});

describe("candidate ordering", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  test("prefers a chosen nickname, then the email local part, then the display name", () => {
    expect(
      deriveUsernameCandidates({ id, nickname: "ada", email: "lovelace@x.com", name: "Ada L" })[0],
    ).toBe("ada");
    expect(
      deriveUsernameCandidates({ id, nickname: null, email: "lovelace@x.com", name: "Ada L" })[0],
    ).toBe("lovelace");
    expect(deriveUsernameCandidates({ id, nickname: null, email: null, name: "Ada L" })[0]).toBe(
      "ada-l",
    );
  });

  test("always ends with an id-derived candidate, so no user is locked out of SSO", () => {
    const candidates = deriveUsernameCandidates({
      id,
      nickname: "🦋",
      email: null,
      name: "!!!",
    });
    expect(candidates).toEqual(["eliza-111111111111"]);
  });

  test("a reserved nickname falls through to the next source instead of failing", () => {
    const candidates = deriveUsernameCandidates({
      id,
      nickname: "admin",
      email: "ada@x.com",
      name: null,
    });
    expect(candidates[0]).toBe("ada");
  });

  test("duplicate sources collapse to one candidate", () => {
    const candidates = deriveUsernameCandidates({
      id,
      nickname: "ada",
      email: "ada@x.com",
      name: "ada",
    });
    expect(candidates.filter((candidate) => candidate === "ada")).toHaveLength(1);
  });

  test("an email without an @ is not treated as a local part", () => {
    const candidates = deriveUsernameCandidates({
      id,
      nickname: null,
      email: "not-an-email",
      name: null,
    });
    expect(candidates).toEqual(["eliza-111111111111"]);
  });
});
