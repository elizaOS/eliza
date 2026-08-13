/**
 * Covers the compatibility redirect for continuation URLs already sent with
 * the retired eliza.app onboarding host.
 */
import { describe, expect, test } from "bun:test";
import { getLegacyOnboardingRedirect } from "../src/lib/legacy-onboarding-redirect";

describe("legacy onboarding redirect", () => {
  test("preserves an existing eliza.app continuation URL", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/get-started",
        search: "?onboardingSession=session-123&source=imessage",
        hash: "#continue",
      }),
    ).toBe(
      "https://app.elizacloud.ai/get-started?onboardingSession=session-123&source=imessage#continue",
    );
  });

  test("supports the legacy www host", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "www.eliza.app",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBe(
      "https://app.elizacloud.ai/get-started?onboardingSession=session-123",
    );
  });

  test("leaves organic homepage onboarding and non-production hosts alone", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/get-started",
        search: "?method=imessage",
        hash: "",
      }),
    ).toBeNull();
    expect(
      getLegacyOnboardingRedirect({
        hostname: "localhost",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
  });
});
