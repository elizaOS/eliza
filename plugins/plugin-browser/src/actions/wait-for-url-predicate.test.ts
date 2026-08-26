/**
 * Predicate tests for BROWSER wait_for_url substring and regex matching.
 */

import { describe, expect, it } from "vitest";
import { buildWaitForUrlPredicate } from "./wait-for-url-predicate.js";

describe("buildWaitForUrlPredicate", () => {
  it("matches a plain substring case-insensitively", () => {
    const predicate = buildWaitForUrlPredicate("callback?code=");
    expect(predicate.kind).toBe("substring");
    expect(predicate.test("https://app.example/callback?code=abc")).toBe(true);
    expect(predicate.test("https://APP.example/CALLBACK?CODE=abc")).toBe(true);
    expect(predicate.test("https://app.example/login")).toBe(false);
  });

  it("treats a /regex/ literal as a regular expression", () => {
    const predicate = buildWaitForUrlPredicate("/\\/deploy\\/.+\\/done$/");
    expect(predicate.kind).toBe("regex");
    expect(predicate.test("https://ci.example/deploy/123/done")).toBe(true);
    expect(predicate.test("https://ci.example/deploy/123/running")).toBe(false);
  });

  it("honors regex literal flags", () => {
    const predicate = buildWaitForUrlPredicate("/DONE$/i");
    expect(predicate.kind).toBe("regex");
    expect(predicate.test("https://ci.example/done")).toBe(true);
  });

  it("treats a bare pattern with metacharacters as a literal substring", () => {
    // Without /.../ wrapping, metacharacters are matched literally.
    const predicate = buildWaitForUrlPredicate("?status=done");
    expect(predicate.kind).toBe("substring");
    expect(predicate.test("https://ci.example/run?status=done")).toBe(true);
    expect(predicate.test("https://ci.example/run?status=running")).toBe(false);
  });

  it("does not treat an ordinary URL path as a regex", () => {
    const predicate = buildWaitForUrlPredicate("github.com/login");
    expect(predicate.kind).toBe("substring");
    expect(predicate.test("https://github.com/login/oauth")).toBe(true);
  });

  it("falls back to a substring match when a regex literal is invalid", () => {
    const predicate = buildWaitForUrlPredicate("/foo[/");
    expect(predicate.kind).toBe("substring");
    // The raw pattern text is matched as a substring.
    expect(predicate.test("https://x.example/foo[/bar")).toBe(true);
    expect(predicate.test("https://x.example/baz")).toBe(false);
  });

  it("never matches an empty pattern", () => {
    const predicate = buildWaitForUrlPredicate("   ");
    expect(predicate.kind).toBe("substring");
    expect(predicate.test("https://anything.example")).toBe(false);
  });
});
