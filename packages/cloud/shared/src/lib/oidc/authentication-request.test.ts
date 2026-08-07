/**
 * Unit coverage for the `prompt` / `max_age` decision. Pure input to output, no
 * harness: the module under test is the one place that decides whether a
 * relying party asking for forced re-authentication is answered or refused.
 *
 * The property each case defends is the same one — an unsatisfiable request
 * must produce an ERROR the relying party can see, never an authorization that
 * quietly reuses the session it asked to bypass.
 */

import { describe, expect, test } from "bun:test";

import { resolveOidcAuthenticationPolicy } from "./authentication-request";

function resolve(prompt: string | null, maxAge: string | null = null) {
  return resolveOidcAuthenticationPolicy({ prompt, maxAge });
}

describe("prompt", () => {
  test("an absent prompt is accepted and asks for nothing", () => {
    const result = resolve(null);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("unreachable");
    expect(result.policy.promptNone).toBe(false);
  });

  test("prompt=none is accepted and recorded", () => {
    const result = resolve("none");
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("unreachable");
    expect(result.policy.promptNone).toBe(true);
  });

  test("prompt=login is refused with login_required, not silently ignored", () => {
    // The whole point of the parameter: the relying party is about to trust
    // this login MORE than a resumed one. Answering from the existing session
    // hands it a re-authentication that never happened.
    const result = resolve("login");
    expect(result).toMatchObject({ status: "rejected", error: "login_required" });
  });

  test("prompt=consent is refused with consent_required", () => {
    expect(resolve("consent")).toMatchObject({
      status: "rejected",
      error: "consent_required",
    });
  });

  test("prompt=select_account is refused with account_selection_required", () => {
    expect(resolve("select_account")).toMatchObject({
      status: "rejected",
      error: "account_selection_required",
    });
  });

  test("prompt=none combined with another value is a malformed request", () => {
    // OpenID Connect Core 3.1.2.1: `none` cannot appear with any other value.
    expect(resolve("none login")).toMatchObject({
      status: "rejected",
      error: "invalid_request",
    });
    expect(resolve("login none")).toMatchObject({
      status: "rejected",
      error: "invalid_request",
    });
  });

  test("an undefined prompt value is refused rather than treated as absent", () => {
    // A typo must not degrade to "no prompt at all" — that is the silent-ignore
    // failure in a different disguise.
    for (const value of ["Login", "NONE", "consent_required", "create", "x"]) {
      expect(resolve(value)).toMatchObject({
        status: "rejected",
        error: "invalid_request",
      });
    }
  });

  test("a prototype member name is an unsupported value, not a lookup hit", () => {
    // These are the keys every JavaScript object inherits. Looking the prompt up
    // in an object literal would answer with a function here, and the rejection
    // built from it would carry `error: undefined` into the redirect.
    for (const value of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "__defineGetter__",
      "isPrototypeOf",
      "propertyIsEnumerable",
    ]) {
      const result = resolve(value);
      expect(result).toMatchObject({ status: "rejected", error: "invalid_request" });
      if (result.status !== "rejected") throw new Error("unreachable");
      expect(result.description).toBe("The prompt parameter contains an unsupported value.");
    }
  });

  test("repeated and irregularly spaced values parse as a set", () => {
    const result = resolve("  none   none ");
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("unreachable");
    expect(result.policy.promptNone).toBe(true);
  });
});

describe("max_age", () => {
  test("an absent max_age is accepted", () => {
    expect(resolve(null, null).status).toBe("accepted");
  });

  test("a well-formed max_age is refused with login_required", () => {
    // Nothing this provider can read says when the user authenticated, so the
    // honest answer is that the constraint cannot be met — never a token that
    // implies it was.
    for (const value of ["0", "1", "300", "86400"]) {
      expect(resolve(null, value)).toMatchObject({
        status: "rejected",
        error: "login_required",
      });
    }
  });

  test("a malformed max_age is a malformed request", () => {
    for (const value of ["-1", "1.5", "abc", "1e3", "+5", " 5", "0x10"]) {
      expect(resolve(null, value)).toMatchObject({
        status: "rejected",
        error: "invalid_request",
      });
    }
  });

  test("an out-of-range max_age is a malformed request", () => {
    expect(resolve(null, "9".repeat(30))).toMatchObject({
      status: "rejected",
      error: "invalid_request",
    });
  });

  test("an unsatisfiable prompt is reported before max_age", () => {
    // Both are refusals, but the prompt names the interaction the relying
    // party actually wanted.
    expect(resolve("consent", "300")).toMatchObject({
      status: "rejected",
      error: "consent_required",
    });
  });

  test("no rejection echoes the submitted value back into the redirect", () => {
    const result = resolve(null, "99999999999999999999999999");
    if (result.status !== "rejected") throw new Error("expected a rejection");
    expect(result.description).not.toContain("99999999999999999999999999");
  });
});
