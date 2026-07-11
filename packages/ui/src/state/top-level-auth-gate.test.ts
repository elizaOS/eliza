/**
 * Unit coverage for the pure top-level auth predicates. These gates decide
 * whether the top-level LoginView owns the screen, whether in-chat onboarding
 * owns it instead, and whether shell pollers must stay unmounted during the
 * initial auth probe.
 */
import { describe, expect, it } from "vitest";
import {
  authProbeShouldHoldShell,
  firstRunOwnsLoginSurface,
  topLevelAuthGateOwnsSurface,
} from "./top-level-auth-gate";

describe("firstRunOwnsLoginSurface — top-level LoginView vs in-chat onboarding", () => {
  it("yields the login surface while the coordinator is in first-run-required", () => {
    expect(firstRunOwnsLoginSurface("first-run-required", false)).toBe(true);
    expect(firstRunOwnsLoginSurface("first-run-required", undefined)).toBe(
      true,
    );
    expect(firstRunOwnsLoginSurface("first-run-required", true)).toBe(true);
  });

  it("ALSO yields when onboarding is incomplete but the coordinator has advanced past first-run-required (the double-login window)", () => {
    // The bug: the coordinator moved to a provisioning/hydrating/ready phase
    // while the in-chat conductor's cloud-OAuth block is still up
    // (firstRunComplete === false). Both login surfaces used to mount.
    for (const phase of ["hydrating", "ready", "starting-runtime"]) {
      expect(firstRunOwnsLoginSurface(phase, false)).toBe(true);
    }
  });

  it("does NOT yield for a normal unauthenticated session (onboarding done)", () => {
    // firstRunComplete === true → the top-level LoginView must still render for
    // a genuine unauthenticated session.
    for (const phase of ["ready", "hydrating", "agentReady"]) {
      expect(firstRunOwnsLoginSurface(phase, true)).toBe(false);
    }
  });

  it("does NOT yield while first-run state is still loading (undefined/null)", () => {
    // Only an EXPLICIT false suppresses the gate — an unknown state must not,
    // or a normal session could be locked out of the top-level login.
    expect(firstRunOwnsLoginSurface("ready", undefined)).toBe(false);
    expect(firstRunOwnsLoginSurface("ready", null)).toBe(false);
  });
});

describe("topLevelAuthGateOwnsSurface — first-run 401 routing", () => {
  it("keeps a shared Cloud app 401 inside in-chat onboarding", () => {
    expect(
      topLevelAuthGateOwnsSurface(
        "first-run-required",
        false,
        "unauthenticated",
        true,
      ),
    ).toBe(false);
    expect(
      topLevelAuthGateOwnsSurface("hydrating", false, "unauthenticated", true),
    ).toBe(false);
  });

  it("lets a real agent backend 401 override optimistic first-run", () => {
    expect(
      topLevelAuthGateOwnsSurface(
        "first-run-required",
        false,
        "unauthenticated",
        false,
      ),
    ).toBe(true);
  });

  it("activates normally after first-run on every origin", () => {
    expect(topLevelAuthGateOwnsSurface("ready", true, "loading", true)).toBe(
      true,
    );
    expect(
      topLevelAuthGateOwnsSurface("ready", true, "authenticated", false),
    ).toBe(true);
  });
});

describe("authProbeShouldHoldShell — pre-auth poll suppression", () => {
  it("holds the shell while auth is loading for a completed returning session", () => {
    expect(authProbeShouldHoldShell("ready", true, "loading")).toBe(true);
    expect(authProbeShouldHoldShell("hydrating", true, "loading")).toBe(true);
  });

  it("does not hold the shell after auth resolves", () => {
    expect(authProbeShouldHoldShell("ready", true, "authenticated")).toBe(
      false,
    );
    expect(authProbeShouldHoldShell("ready", true, "unauthenticated")).toBe(
      false,
    );
    expect(authProbeShouldHoldShell("ready", true, "server_unavailable")).toBe(
      false,
    );
  });

  it("does not steal the first-run login surface while onboarding owns it", () => {
    expect(
      authProbeShouldHoldShell("first-run-required", false, "loading"),
    ).toBe(false);
    expect(authProbeShouldHoldShell("ready", false, "loading")).toBe(false);
  });
});
