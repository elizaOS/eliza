/**
 * Product-mode policy for the cloud-first app shell.
 */
import { describe, expect, it } from "vitest";
import { canOfferLocalRemoteOnboarding } from "./cloud-only";

describe("canOfferLocalRemoteOnboarding", () => {
  it("keeps local and remote onboarding available outside production", () => {
    expect(canOfferLocalRemoteOnboarding({ PROD: false })).toBe(true);
  });

  it("hides local and remote onboarding by default in production", () => {
    expect(canOfferLocalRemoteOnboarding({ PROD: true })).toBe(false);
  });

  it("allows explicit production opt-in for testing local and remote paths", () => {
    expect(
      canOfferLocalRemoteOnboarding({
        PROD: true,
        VITE_ELIZA_ENABLE_LOCAL_REMOTE_ONBOARDING: "1",
      }),
    ).toBe(true);
  });

  it("allows explicit opt-out in dev and test builds", () => {
    expect(
      canOfferLocalRemoteOnboarding({
        PROD: false,
        VITE_ELIZA_ENABLE_LOCAL_REMOTE_ONBOARDING: "0",
      }),
    ).toBe(false);
  });
});
