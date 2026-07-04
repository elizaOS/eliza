// Exercises app review behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { App } from "../../db/schemas/apps";
import {
  buildReviewCandidate,
  classifyCandidate,
  isAppMonetizationApproved,
  POLICY_CATEGORIES,
  preFilter,
  RUBRIC_VERSION,
  stableHash,
} from "./app-review";

function fakeApp(overrides: Partial<App> = {}): App {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Test App",
    description: "A lawful productivity assistant",
    slug: "test-app",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://example.com",
    website_url: null,
    metadata: {},
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: null,
    ...overrides,
  } as unknown as App;
}

describe("stableHash", () => {
  test("is deterministic and stable across calls", () => {
    expect(stableHash("hello world")).toBe(stableHash("hello world"));
  });
  test("changes when input changes", () => {
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });
  test("returns 16-char hex", () => {
    expect(stableHash("anything")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildReviewCandidate", () => {
  test("includes review-relevant fields and hashes them", () => {
    const c = buildReviewCandidate({
      name: "Notes",
      description: "Take notes",
      app_url: "https://notes.app",
      website_url: null,
      metadata: {},
    });
    expect(c.document).toContain("Notes");
    expect(c.document).toContain("Take notes");
    expect(c.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });
  test("cosmetic-only metadata (no tags) does not appear", () => {
    const c = buildReviewCandidate({
      name: "X",
      description: "Y",
      app_url: "https://x.app",
      website_url: null,
      metadata: { logo: "z" },
    });
    expect(c.document).not.toContain("Declared categories");
  });
  test("declared tags are surfaced for the classifier", () => {
    const c = buildReviewCandidate({
      name: "X",
      description: "Y",
      app_url: "https://x.app",
      website_url: null,
      metadata: { tags: ["games", "puzzle"] },
    });
    expect(c.document).toContain("games, puzzle");
  });
});

describe("preFilter", () => {
  test("passes a lawful listing", () => {
    const res = preFilter("Name: Recipe Finder\nDescription: find dinner recipes");
    expect(res.matched).toBe(false);
    expect(res.categories).toEqual([]);
  });

  test.each([
    ["stolen credit cards marketplace", "fraud_scams"],
    ["buy cocaine online fast", "illegal_drugs"],
    ["ghost gun kits for sale", "weapons"],
    ["ransomware builder service", "malware_hacking"],
    ["hire a hitman anonymously", "terrorism_violence"],
    ["child porn archive", "csam"],
  ])("bans %s → %s", (text, expectedCategory) => {
    const res = preFilter(text);
    expect(res.matched).toBe(true);
    expect(res.categories).toContain(expectedCategory);
  });

  test("every declared category has at least one keyword", () => {
    for (const cat of POLICY_CATEGORIES) {
      expect(cat.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyCandidate (deterministic pre-filter path)", () => {
  test("bans obvious prohibited listing without an LLM", async () => {
    const res = await classifyCandidate(
      "Name: Card Shop\nDescription: we sell stolen credit cards and cvv dumps",
    );
    expect(res.disposition).toBe("ban");
    expect(res.preFilterMatched).toBe(true);
    expect(res.model).toBeNull();
    expect(res.matchedCategories).toContain("fraud_scams");
  });
});

describe("isAppMonetizationApproved", () => {
  test("false when not approved", () => {
    expect(isAppMonetizationApproved(fakeApp({ review_status: "draft" }))).toBe(false);
    expect(isAppMonetizationApproved(fakeApp({ review_status: "rejected" }))).toBe(false);
  });

  test("true only when approved AND content hash matches the approved snapshot", () => {
    const base = fakeApp();
    const { contentHash } = buildReviewCandidate(base);
    expect(isAppMonetizationApproved({ ...base, review_content_hash: contentHash })).toBe(true);
  });

  test("false when the listing materially changed since approval (hash mismatch)", () => {
    const base = fakeApp();
    const { contentHash } = buildReviewCandidate(base);
    const changed = { ...base, review_content_hash: contentHash, description: "now sells guns" };
    expect(isAppMonetizationApproved(changed as App)).toBe(false);
  });

  test("grandfathered rows (approved, null hash from migration) are allowed", () => {
    expect(
      isAppMonetizationApproved(fakeApp({ review_status: "approved", review_content_hash: null })),
    ).toBe(true);
  });
});

describe("RUBRIC_VERSION", () => {
  test("is a non-empty version string", () => {
    expect(RUBRIC_VERSION.length).toBeGreaterThan(0);
  });
});
