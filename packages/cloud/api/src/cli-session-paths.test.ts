/**
 * Thin CLI-session dispatch predicate: exactly the create POST and the
 * single-segment poll GET go to the thin shell; the authenticated
 * `/:sessionId/complete` mutation must always fall through to the full app.
 */
import { describe, expect, test } from "bun:test";
import { isThinCliSessionPath } from "./cli-session-paths";

describe("isThinCliSessionPath", () => {
  test("routes create POST and its preflight to the thin shell", () => {
    expect(isThinCliSessionPath("POST", "/api/auth/cli-session")).toBe(true);
    expect(isThinCliSessionPath("OPTIONS", "/api/auth/cli-session")).toBe(true);
    expect(isThinCliSessionPath("post", "/api/auth/cli-session/")).toBe(true);
  });

  test("routes single-segment poll GET/HEAD and preflight to the thin shell", () => {
    const poll = "/api/auth/cli-session/bbbbbbbb-2222-4333-8444-cccccccccccc";
    expect(isThinCliSessionPath("GET", poll)).toBe(true);
    expect(isThinCliSessionPath("HEAD", poll)).toBe(true);
    expect(isThinCliSessionPath("OPTIONS", poll)).toBe(true);
  });

  test("never captures the authenticated complete mutation", () => {
    const complete =
      "/api/auth/cli-session/bbbbbbbb-2222-4333-8444-cccccccccccc/complete";
    expect(isThinCliSessionPath("POST", complete)).toBe(false);
    expect(isThinCliSessionPath("GET", complete)).toBe(false);
    expect(isThinCliSessionPath("OPTIONS", complete)).toBe(false);
  });

  test("rejects methods the thin routes do not implement", () => {
    expect(isThinCliSessionPath("GET", "/api/auth/cli-session")).toBe(false);
    expect(isThinCliSessionPath("PUT", "/api/auth/cli-session")).toBe(false);
    expect(isThinCliSessionPath("POST", "/api/auth/cli-session/some-id")).toBe(
      false,
    );
    expect(isThinCliSessionPath("DELETE", "/api/auth/cli-session/x")).toBe(
      false,
    );
  });

  test("leaves unrelated paths to the other dispatchers", () => {
    expect(isThinCliSessionPath("GET", "/api/auth/cli-sessions")).toBe(false);
    expect(isThinCliSessionPath("POST", "/api/auth")).toBe(false);
    expect(isThinCliSessionPath("GET", "/steward/auth/providers")).toBe(false);
    expect(isThinCliSessionPath("POST", "/api/v1/cli-auth/x/token")).toBe(
      false,
    );
  });
});
