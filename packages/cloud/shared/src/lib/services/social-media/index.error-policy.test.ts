/**
 * Error-policy pins for the social-media read paths (#13415): a legitimately
 * unsupported capability (a designed-empty domain result) must stay
 * distinguishable from an internal failure. `getPostAnalytics` /
 * `getAccountAnalytics` return `null` ONLY when the provider does not implement
 * analytics (e.g. Discord); a missing-credentials failure THROWS, and a provider
 * that throws propagates rather than being swallowed into a fake-empty result.
 *
 * Drives the real exported `socialMediaService`; `getCredentialsForPlatform` and
 * provider methods are spied per the sibling credit-refund test's idiom.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

// Alert fan-out is env-gated fire-and-forget; stub so the read paths never touch the network.
mock.module("./alerts", () => ({
  alertOnPostFailure: async () => {},
}));

const { socialMediaService } = await import("./index");
const { twitterProvider } = await import("./providers/twitter");

const ORG_ID = "00000000-0000-4000-8000-00000000b001";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("analytics read paths — designed-empty stays distinct from failure (#13415)", () => {
  test("unsupported provider returns null WITHOUT resolving credentials (designed-empty)", async () => {
    // Discord implements neither analytics method. If the null short-circuit ever
    // regressed to fall through to credential resolution, this spy would fire.
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform");
    spies.push(credsSpy);

    const post = await socialMediaService.getPostAnalytics({
      organizationId: ORG_ID,
      platform: "discord",
      postId: "post-1",
    });
    const account = await socialMediaService.getAccountAnalytics({
      organizationId: ORG_ID,
      platform: "discord",
    });

    expect(post).toBeNull();
    expect(account).toBeNull();
    // Designed-empty is decided before any credential I/O.
    expect(credsSpy).not.toHaveBeenCalled();
  });

  test("missing credentials on a supported provider THROWS (failure != empty)", async () => {
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform").mockImplementation(
      async () => null,
    );
    spies.push(credsSpy);

    // A null from an analytics-capable platform is an internal failure (no creds),
    // NOT a designed-empty result — it must surface as a throw, never a null.
    await expect(
      socialMediaService.getPostAnalytics({
        organizationId: ORG_ID,
        platform: "twitter",
        postId: "post-1",
      }),
    ).rejects.toThrow(/No credentials found for twitter/);

    await expect(
      socialMediaService.getAccountAnalytics({ organizationId: ORG_ID, platform: "twitter" }),
    ).rejects.toThrow(/No credentials found for twitter/);
  });

  test("provider analytics failure PROPAGATES (not swallowed into null)", async () => {
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform").mockImplementation(
      async () => ({ platform: "twitter" as const, accessToken: "tok" }),
    );
    const analyticsSpy = spyOn(twitterProvider, "getPostAnalytics").mockImplementation(async () => {
      throw new Error("Twitter API 503: analytics unavailable");
    });
    spies.push(credsSpy, analyticsSpy);

    await expect(
      socialMediaService.getPostAnalytics({
        organizationId: ORG_ID,
        platform: "twitter",
        postId: "post-1",
      }),
    ).rejects.toThrow(/analytics unavailable/);
  });

  test("missing postId is rejected as invalid input, not treated as empty", async () => {
    await expect(
      socialMediaService.getPostAnalytics({
        organizationId: ORG_ID,
        platform: "twitter",
        postId: "",
      }),
    ).rejects.toThrow(/postId is required/);
  });
});
