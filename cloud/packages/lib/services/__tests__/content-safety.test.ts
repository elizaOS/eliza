import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OPENAI_MODERATION_API_KEY = process.env.OPENAI_MODERATION_API_KEY;
const ORIGINAL_CONTENT_SAFETY_MODE = process.env.CONTENT_SAFETY_MODE;
const ORIGINAL_CONTENT_SAFETY_REQUIRE_CONFIG = process.env.CONTENT_SAFETY_REQUIRE_CONFIG;
const ORIGINAL_CONTENT_SAFETY_FAIL_OPEN = process.env.CONTENT_SAFETY_FAIL_OPEN;

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv("OPENAI_API_KEY", ORIGINAL_OPENAI_API_KEY);
  restoreEnv("OPENAI_MODERATION_API_KEY", ORIGINAL_OPENAI_MODERATION_API_KEY);
  restoreEnv("CONTENT_SAFETY_MODE", ORIGINAL_CONTENT_SAFETY_MODE);
  restoreEnv("CONTENT_SAFETY_REQUIRE_CONFIG", ORIGINAL_CONTENT_SAFETY_REQUIRE_CONFIG);
  restoreEnv("CONTENT_SAFETY_FAIL_OPEN", ORIGINAL_CONTENT_SAFETY_FAIL_OPEN);
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function moderationResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "modr_test",
      model: "omni-moderation-latest",
      results: [
        {
          flagged: false,
          categories: {},
          category_scores: {},
          category_applied_input_types: {},
          ...overrides,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("contentSafetyService", () => {
  test("skips when no moderation key is configured unless required", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODERATION_API_KEY;
    const { contentSafetyService } = await import(`../content-safety.ts?case=no-key-${Date.now()}`);

    const review = await contentSafetyService.reviewPublicContent({
      surface: "advertising_creative",
      text: "Safe ad copy",
    });

    expect(review.allowed).toBe(true);
    expect(review.skipped).toBe(true);
    expect(review.issues).toContain("moderation_not_configured");
  });

  test("sends multimodal moderation payloads to OpenAI", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return moderationResponse();
    }) as typeof fetch;

    const { contentSafetyService } = await import(
      `../content-safety.ts?case=payload-${Date.now()}`
    );

    const review = await contentSafetyService.reviewPublicContent({
      surface: "media_generation_prompt",
      text: "Generate a launch image",
      imageUrls: ["data:image/png;base64,AAAA"],
      allowDataImages: true,
    });

    expect(review.allowed).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      model: string;
      input: Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    expect(body.model).toBe("omni-moderation-latest");
    expect(body.input[0]).toEqual({ type: "text", text: "Generate a launch image" });
    expect(body.input[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  test("blocks flagged public content in enforce mode", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      moderationResponse({
        flagged: true,
        categories: { "sexual/minors": true },
        category_scores: { "sexual/minors": 0.99 },
      })) as typeof fetch;

    const { contentSafetyService } = await import(`../content-safety.ts?case=block-${Date.now()}`);

    await expect(
      contentSafetyService.assertSafeForPublicUse({
        surface: "advertising_creative",
        text: "unsafe",
      }),
    ).rejects.toThrow(ApiError);
  });

  test("fails closed when moderation is configured but unavailable", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;

    const { contentSafetyService } = await import(
      `../content-safety.ts?case=unavailable-${Date.now()}`
    );

    await expect(
      contentSafetyService.assertSafeForPublicUse({
        surface: "promotion_copy",
        text: "Safe text",
      }),
    ).rejects.toThrow("Content safety moderation is unavailable");
  });
});
