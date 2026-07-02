/**
 * Regression tests for the charge-then-throw money leak in
 * `socialMediaService.createPost` / `replyToPost` (#11680).
 *
 * The bug: `createPost` deducted credits for ALL platforms up front, then
 * awaited `getCredentialsForPlatform` OUTSIDE the per-platform try. That
 * method THROWS ("Token expired. …") when a stored OAuth token is expired and
 * the refresh fails, which rejected the whole `Promise.all` — so the
 * per-platform refund (which only inspects settled `{success:false}` results)
 * never ran. One revoked credential = user charged for every platform,
 * nothing posted, no refund. Same class in `replyToPost`: the provider call
 * was unwrapped, so a THROWN provider error (vs a returned `{success:false}`)
 * skipped the refund.
 *
 * These tests drive the real `createPost`/`replyToPost` control flow and pin:
 *  - a thrown credential error resolves to `{success:false}` and is refunded
 *    (net charge 0 on total failure),
 *  - partial-refund accounting is exact (only failed platforms refunded),
 *  - a throwing reply provider still triggers the refund.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

interface RecordedCall {
  organizationId: string;
  amount: number;
  description: string;
  metadata?: Record<string, unknown>;
}

const deductCalls: RecordedCall[] = [];
const refundCalls: RecordedCall[] = [];

mock.module("../credits", () => ({
  creditsService: {
    deductCredits: async (params: RecordedCall) => {
      deductCalls.push(params);
      return { success: true, newBalance: 100, transaction: null };
    },
    refundCredits: async (params: RecordedCall) => {
      refundCalls.push(params);
      return { transaction: {}, newBalance: 100 };
    },
  },
}));

// Alert fan-out is env-gated fire-and-forget; stub it so tests never touch the network.
mock.module("./alerts", () => ({
  alertOnPostFailure: async () => {},
}));

const { socialMediaService } = await import("./index");
const { blueskyProvider } = await import("./providers/bluesky");
const { twitterProvider } = await import("./providers/twitter");

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";
const POST_CREDIT_COST = 0.01;
const TOKEN_EXPIRED = "Token expired. Please reconnect your account.";

const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  deductCalls.length = 0;
  refundCalls.length = 0;
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("createPost refund on thrown credential error (#11680)", () => {
  test("refunds every platform when credential resolution throws — net charge is 0", async () => {
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform").mockImplementation(
      async () => {
        throw new Error(TOKEN_EXPIRED);
      },
    );
    spies.push(credsSpy);

    const result = await socialMediaService.createPost({
      organizationId: ORG_ID,
      userId: USER_ID,
      content: { text: "hello world" },
      platforms: ["twitter", "linkedin"],
    });

    // The thrown cred error must resolve to per-platform failures, not reject.
    expect(result.totalPlatforms).toBe(2);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
    for (const r of result.results) {
      expect(r.success).toBe(false);
      expect(r.error).toContain("Token expired");
    }

    // Charged for 2 platforms, refunded for 2 platforms — net 0.
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0]?.amount).toBeCloseTo(2 * POST_CREDIT_COST, 10);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]?.amount).toBeCloseTo(2 * POST_CREDIT_COST, 10);

    const netCharge = deductCalls[0].amount - refundCalls[0].amount;
    expect(netCharge).toBeCloseTo(0, 10);
  });

  test("refunds ONLY the failed platform when another platform succeeds", async () => {
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform").mockImplementation(
      async (_orgId, platform) => {
        if (platform === "twitter") throw new Error(TOKEN_EXPIRED);
        return { platform, handle: "tester.bsky.social", appPassword: "app-pass" };
      },
    );
    const postSpy = spyOn(blueskyProvider, "createPost").mockImplementation(async () => ({
      platform: "bluesky" as const,
      success: true,
      postId: "post-123",
    }));
    spies.push(credsSpy, postSpy);

    const result = await socialMediaService.createPost({
      organizationId: ORG_ID,
      userId: USER_ID,
      content: { text: "hello world" },
      platforms: ["twitter", "bluesky"],
    });

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.successful[0]?.platform).toBe("bluesky");
    expect(result.failed[0]?.platform).toBe("twitter");

    // Charged 2x, refunded exactly 1x — partial-refund accounting preserved.
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0]?.amount).toBeCloseTo(2 * POST_CREDIT_COST, 10);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]?.amount).toBeCloseTo(1 * POST_CREDIT_COST, 10);
    expect(refundCalls[0]?.metadata?.failedPlatforms).toEqual(["twitter"]);
  });
});

describe("replyToPost refund on thrown provider error (#11680)", () => {
  test("refunds the reply charge when the provider throws instead of returning {success:false}", async () => {
    const credsSpy = spyOn(socialMediaService, "getCredentialsForPlatform").mockImplementation(
      async () => ({ platform: "twitter" as const, accessToken: "tok" }),
    );
    const replySpy = spyOn(twitterProvider, "replyToPost").mockImplementation(async () => {
      throw new Error("Twitter API 500: upstream unavailable");
    });
    spies.push(credsSpy, replySpy);

    const result = await socialMediaService.replyToPost(ORG_ID, "twitter", "orig-post-1", {
      text: "reply text",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("upstream unavailable");

    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0]?.amount).toBeCloseTo(POST_CREDIT_COST, 10);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]?.amount).toBeCloseTo(POST_CREDIT_COST, 10);
  });
});
