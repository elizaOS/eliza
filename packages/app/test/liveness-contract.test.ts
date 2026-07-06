// Unit test for the onboarding liveness contract (#14359). Exercises the pure,
// surface-agnostic core (`assertLiveReply` / `isLiveReply`) — the rule every
// onboarding lane shares — with no DOM/Playwright harness: a stub-marker reply
// must fail, a real reply must pass, and empty/non-string replies must fail.
import { describe, expect, it } from "vitest";

import {
  assertLiveReply,
  isLiveReply,
  LivenessAssertionError,
  STUB_FIXTURE_MARKER,
} from "./liveness-contract.mjs";

describe("onboarding liveness contract", () => {
  it("passes a real, non-empty reply and returns it trimmed", () => {
    expect(assertLiveReply("  Hello there!  ")).toBe("Hello there!");
    expect(isLiveReply("Hello there!")).toBe(true);
  });

  it("fails a reply carrying the stub fixture marker", () => {
    const stubbed = `{"fixture":"${STUB_FIXTURE_MARKER}","transport":"sse"}`;
    expect(() => assertLiveReply(stubbed)).toThrowError(LivenessAssertionError);
    expect(() => assertLiveReply(stubbed)).toThrow(/stub fixture marker/);
    expect(isLiveReply(stubbed)).toBe(false);
  });

  it("fails an empty or whitespace-only reply (model never answered)", () => {
    expect(() => assertLiveReply("")).toThrow(/empty/);
    expect(() => assertLiveReply("   \n\t ")).toThrow(/empty/);
    expect(isLiveReply("")).toBe(false);
  });

  it("fails a non-string reply", () => {
    expect(() => assertLiveReply(null)).toThrow(/must be a string/);
    expect(() => assertLiveReply(undefined)).toThrow(/must be a string/);
    expect(() => assertLiveReply(42)).toThrow(/must be a string/);
    expect(isLiveReply(null)).toBe(false);
  });

  it("attributes the failure to the lane label when provided", () => {
    expect(() =>
      assertLiveReply(STUB_FIXTURE_MARKER, { label: "android-onboarding" }),
    ).toThrow(/android-onboarding: /);
  });
});
