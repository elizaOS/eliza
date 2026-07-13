/**
 * Unit coverage for the pure top-level auth predicates. These gates decide
 * whether shell pollers must stay unmounted during the initial auth probe.
 */
import { describe, expect, it } from "vitest";
import { authProbeShouldHoldShell } from "./top-level-auth-gate";

describe("authProbeShouldHoldShell — pre-auth poll suppression", () => {
  it("holds every shell while auth is loading", () => {
    expect(authProbeShouldHoldShell("loading")).toBe(true);
  });

  it("does not hold the shell after auth resolves", () => {
    expect(authProbeShouldHoldShell("authenticated")).toBe(false);
    expect(authProbeShouldHoldShell("unauthenticated")).toBe(false);
    expect(authProbeShouldHoldShell("server_unavailable")).toBe(false);
  });
});
