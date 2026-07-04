/**
 * Unit coverage for `firstRunOwnsLoginSurface`, the pure predicate that decides
 * whether the top-level LoginView owns the screen versus in-chat onboarding.
 * Guards the double-login window (onboarding incomplete but coordinator past
 * first-run-required). Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import { firstRunOwnsLoginSurface } from "./top-level-auth-gate";

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
