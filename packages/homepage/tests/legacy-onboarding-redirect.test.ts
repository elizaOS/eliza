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
      "https://cloud.eliza.app/get-started?onboardingSession=session-123&source=imessage#continue",
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
    ).toBe("https://cloud.eliza.app/get-started?onboardingSession=session-123");
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

describe("legacy onboarding redirect host matching", () => {
  test("matches allowlisted production hosts case-insensitively", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "ELIZA.APP",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBe("https://cloud.eliza.app/get-started?onboardingSession=session-123");
    expect(
      getLegacyOnboardingRedirect({
        hostname: "Www.Eliza.App",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "#top",
      }),
    ).toBe(
      "https://cloud.eliza.app/get-started?onboardingSession=session-123#top",
    );
  });

  test("rejects lookalike hosts that merely contain eliza.app", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app.evil.com",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
    expect(
      getLegacyOnboardingRedirect({
        hostname: "noteliza.app",
        pathname: "/get-started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
  });
});

describe("legacy onboarding redirect continuation gates", () => {
  test("redirects only the exact /get-started pathname", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/get-started/",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/Get-Started",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/",
        search: "?onboardingSession=session-123",
        hash: "",
      }),
    ).toBeNull();
  });

  test("treats an empty onboardingSession value as still present", () => {
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/get-started",
        search: "?onboardingSession=",
        hash: "",
      }),
    ).toBe("https://cloud.eliza.app/get-started?onboardingSession=");
  });

  test("finds onboardingSession wherever it appears among the query parameters", () => {
    const search = "?source=imessage&onboardingSession=session-9&app=memory";
    expect(
      getLegacyOnboardingRedirect({
        hostname: "eliza.app",
        pathname: "/get-started",
        search,
        hash: "",
      }),
    ).toBe(`https://cloud.eliza.app/get-started${search}`);
  });
});
