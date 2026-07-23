/**
 * Exercises affiliate inference policy against the real in-memory cache.
 *
 * Repository hydration is isolated behind a tripwire so warm attribution proves
 * the beneficiary and markup come entirely from the pre-dispatch cache record.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, expect, mock, test } from "bun:test";

interface AffiliateRow {
  id: string;
  user_id: string;
  code: string;
  parent_referral_id: string | null;
  markup_percent: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

let repositoryRecord: AffiliateRow | null = null;
let repositoryReads = 0;
const getAffiliateCodeByCode = mock(async () => {
  repositoryReads++;
  return repositoryRecord;
});

mock.module("../../db/repositories/affiliates", () => ({
  affiliatesRepository: {
    getAffiliateCodeByCode,
  },
}));

const { cache } = await import("../cache/client");
const { CacheKeys, CacheTTL } = await import("../cache/keys");
const {
  __clearInferenceAffiliateCacheState,
  getCachedInferenceAffiliateAttribution,
  getCachedInferenceAffiliateMarkup,
  InferenceAffiliateCacheUnavailableError,
  InferenceAffiliateCacheWarmingError,
} = await import("./inference-affiliate-cache");

let sequence = 0;

function nextCode(label: string): string {
  sequence++;
  return `${label}-${sequence}`;
}

function affiliateRow(code: string, overrides: Partial<AffiliateRow> = {}): AffiliateRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    code,
    parent_referral_id: null,
    markup_percent: "20.00",
    is_active: true,
    created_at: new Date("2026-07-23T00:00:00.000Z"),
    updated_at: new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
}

function params(
  code: string,
  background: Promise<unknown>[],
  userId = "00000000-0000-4000-8000-000000000003",
) {
  return {
    affiliateCode: code,
    organizationId: "payer-org",
    userId,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
  };
}

beforeEach(() => {
  repositoryRecord = null;
  repositoryReads = 0;
  getAffiliateCodeByCode.mockClear();
  __clearInferenceAffiliateCacheState();
});

test("cold hydration produces a pinned warm attribution without another repository read", async () => {
  const code = nextCode("PARTNER");
  repositoryRecord = affiliateRow(code);
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedInferenceAffiliateAttribution(params(code, background)),
  ).rejects.toBeInstanceOf(InferenceAffiliateCacheWarmingError);
  expect(background).toHaveLength(1);
  await background[0];
  expect(repositoryReads).toBe(1);

  const attribution = await getCachedInferenceAffiliateAttribution(params(code, []));
  expect(attribution).toEqual({
    affiliateCodeId: "00000000-0000-4000-8000-000000000001",
    affiliateUserId: "00000000-0000-4000-8000-000000000002",
    affiliateCode: code,
    markupPercent: 0.2,
  });
  expect(Object.isFrozen(attribution)).toBe(true);
  expect(await getCachedInferenceAffiliateMarkup(params(code, []))).toBe(0.2);
  expect(repositoryReads).toBe(1);
});

test("missing, inactive, self-referral, and zero-markup policies are explicit no-attribution", async () => {
  const cases: Array<{
    label: string;
    record: AffiliateRow | null;
    userId?: string;
  }> = [
    { label: "missing", record: null },
    {
      label: "inactive",
      record: affiliateRow("placeholder", { is_active: false }),
    },
    {
      label: "self",
      record: affiliateRow("placeholder", {
        user_id: "00000000-0000-4000-8000-000000000003",
      }),
      userId: "00000000-0000-4000-8000-000000000003",
    },
    {
      label: "zero",
      record: affiliateRow("placeholder", { markup_percent: "0" }),
    },
  ];

  for (const testCase of cases) {
    const code = nextCode(testCase.label);
    repositoryRecord = testCase.record ? { ...testCase.record, code } : null;
    const background: Promise<unknown>[] = [];
    await expect(
      getCachedInferenceAffiliateAttribution(params(code, background, testCase.userId)),
    ).rejects.toBeInstanceOf(InferenceAffiliateCacheWarmingError);
    await background[0];

    expect(
      await getCachedInferenceAffiliateAttribution(params(code, [], testCase.userId)),
    ).toBeNull();
    expect(await getCachedInferenceAffiliateMarkup(params(code, [], testCase.userId))).toBe(0);
  }
});

test("malformed cached money policy fails closed and repairs asynchronously", async () => {
  const code = nextCode("MALFORMED");
  const write = await cache.setWithOutcome(
    CacheKeys.affiliate.codeByCode(code),
    affiliateRow(code, { markup_percent: "not-a-number" }),
    CacheTTL.affiliate.data,
  );
  expect(write.kind).toBe("written");
  repositoryRecord = affiliateRow(code, { markup_percent: "35" });
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedInferenceAffiliateAttribution(params(code, background)),
  ).rejects.toBeInstanceOf(InferenceAffiliateCacheUnavailableError);
  expect(background).toHaveLength(1);
  await background[0];

  expect(await getCachedInferenceAffiliateAttribution(params(code, []))).toEqual({
    affiliateCodeId: "00000000-0000-4000-8000-000000000001",
    affiliateUserId: "00000000-0000-4000-8000-000000000002",
    affiliateCode: code,
    markupPercent: 0.35,
  });
  expect(repositoryReads).toBe(1);
});

test("blank cached payout identities and numeric strings fail before provider admission", async () => {
  const malformedRows: Array<Partial<AffiliateRow>> = [
    { id: " " },
    { user_id: "" },
    { markup_percent: " " },
  ];

  for (const [index, malformed] of malformedRows.entries()) {
    const code = nextCode(`BLANK-${index}`);
    const write = await cache.setWithOutcome(
      CacheKeys.affiliate.codeByCode(code),
      affiliateRow(code, malformed),
      CacheTTL.affiliate.data,
    );
    expect(write.kind).toBe("written");
    repositoryRecord = affiliateRow(code);
    const background: Promise<unknown>[] = [];

    await expect(
      getCachedInferenceAffiliateAttribution(params(code, background)),
    ).rejects.toBeInstanceOf(InferenceAffiliateCacheUnavailableError);
    expect(background).toHaveLength(1);
    await background[0];
    expect(await getCachedInferenceAffiliateAttribution(params(code, []))).toEqual({
      affiliateCodeId: "00000000-0000-4000-8000-000000000001",
      affiliateUserId: "00000000-0000-4000-8000-000000000002",
      affiliateCode: code,
      markupPercent: 0.2,
    });
  }
  expect(repositoryReads).toBe(malformedRows.length);
});

test("anonymous inference never hydrates or carries affiliate attribution", async () => {
  const code = nextCode("ANON");
  repositoryRecord = affiliateRow(code);
  const background: Promise<unknown>[] = [];

  await expect(
    getCachedInferenceAffiliateAttribution({
      ...params(code, background),
      organizationId: "anonymous",
    }),
  ).resolves.toBeNull();
  expect(background).toHaveLength(0);
  expect(repositoryReads).toBe(0);
});
