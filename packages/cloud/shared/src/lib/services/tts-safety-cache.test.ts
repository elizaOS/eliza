import { beforeEach, expect, mock, test } from "bun:test";

const env: Record<string, string> = {
  OPENAI_MODERATION_API_KEY: "private-key",
  CONTENT_SAFETY_MODE: "enforce",
};
const values = new Map<string, string>();
let checks = 0;
let review = {
  allowed: true,
  skipped: false,
  flagged: false,
  mode: "enforce",
  issues: [] as string[],
};
let failure: Error | undefined;
mock.module("../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => env,
  getCloudBinding: () => ({
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  }),
}));
mock.module("./content-safety", () => ({
  contentSafetyService: {
    async assertSafeForPublicUse() {
      checks++;
      if (failure) throw failure;
      return review;
    },
  },
}));
const { assertSafeTtsText } = await import("./tts-safety-cache");
beforeEach(() => {
  checks = 0;
  values.clear();
  failure = undefined;
  review = { allowed: true, skipped: false, flagged: false, mode: "enforce", issues: [] };
});
const input = (text: string) => ({
  surface: "media_generation_prompt" as const,
  organizationId: "test-org",
  userId: "test-user",
  text,
});

test("an exact approved TTS repeat avoids moderation; new text/model/key/policy requires review", async () => {
  const value = input("A unique approved voice reply.");
  expect(await assertSafeTtsText(value)).toBe("reviewed");
  expect(await assertSafeTtsText(value)).toBe("approved-hit");
  expect(checks).toBe(1);
  await assertSafeTtsText(input("A different reply."));
  env.OPENAI_MODERATION_MODEL = "new-model";
  await assertSafeTtsText(value);
  env.OPENAI_MODERATION_API_KEY = "rotated-key";
  await assertSafeTtsText(value);
  env.CONTENT_SAFETY_FAIL_OPEN = "true";
  await assertSafeTtsText(value);
  expect(checks).toBe(5);
  expect([...values.keys()].join()).not.toContain(value.text);
  expect([...values.keys()].join()).not.toContain("private-key");
});

test("skipped, warn-only, flagged, and degraded results never authorize a cached repeat", async () => {
  for (const changed of [
    { skipped: true },
    { mode: "warn" },
    { flagged: true },
    { issues: ["moderation_unavailable_transport"] },
  ]) {
    review = {
      allowed: true,
      skipped: false,
      flagged: false,
      mode: "enforce",
      issues: [],
      ...changed,
    };
    const value = input(`Uncacheable reply ${JSON.stringify(changed)}`);
    expect(await assertSafeTtsText(value)).toBeUndefined();
    expect(await assertSafeTtsText(value)).toBeUndefined();
  }
  expect(checks).toBe(8);
  expect(values.size).toBe(0);
});

test("provider rejection is retained and cannot poison later safety decisions", async () => {
  const value = input("Rejected unique reply.");
  failure = Error("moderation unavailable");
  await expect(assertSafeTtsText(value)).rejects.toThrow("moderation unavailable");
  await expect(assertSafeTtsText(value)).rejects.toThrow("moderation unavailable");
  expect(checks).toBe(2);
  expect(values.size).toBe(0);
  failure = undefined;
  expect(await assertSafeTtsText(value)).toBe("reviewed");
});
