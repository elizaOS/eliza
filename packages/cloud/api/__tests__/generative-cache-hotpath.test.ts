/**
 * Guards every thin generative Worker route against reintroducing direct
 * database access, legacy auth, or synchronous credit reservation around
 * provider dispatch. This source tripwire complements route behavior tests.
 */

import { describe, expect, test } from "bun:test";

const routePaths = [
  "v1/voice/tts/route.ts",
  "v1/voice/stt/route.ts",
  "v1/generate-image/route.ts",
  "v1/generate-video/route.ts",
  "v1/generate-music/route.ts",
  "v1/generate-sfx/route.ts",
] as const;

describe("canonical generative cache-only hot path", () => {
  for (const routePath of routePaths) {
    test(`${routePath} uses combined auth and flat admission`, async () => {
      const source = await Bun.file(
        new URL(`../${routePath}`, import.meta.url),
      ).text();
      expect(source).toContain("requireGenerativeRouteCaller");
      expect(source).toContain("admitFlatGenerativeOperation");
      expect(source).toContain("admissionSnapshot");
      expect(source).toContain('rateLimitEndpoint: "strict"');
      expect(source).not.toContain("requireUserOrApiKeyWithOrg");
      expect(source).not.toContain("requireAuthOrApiKeyWithOrg");
      expect(source).not.toContain("reserveFlatUsageCredits");
      expect(source).not.toContain("rate-limit-hono-cloudflare");
      expect(source).not.toMatch(/from\s+["']@\/db\//);
    });
  }

  for (const routePath of [
    "v1/apps/[id]/chat/route.ts",
    "v1/apps/[id]/generate-image/route.ts",
  ] as const) {
    test(`${routePath} delegates to a canonical cache-only route`, async () => {
      const source = await Bun.file(
        new URL(`../${routePath}`, import.meta.url),
      ).text();
      expect(source).toMatch(/handle(ChatCompletions|GenerateImage)POST/);
      expect(source).not.toMatch(/from\s+["']@\/db\//);
      expect(source).not.toContain("appsService.getById");
      expect(source).not.toContain("appCreditsService.deductCredits");
      expect(source).not.toContain("requireUserOrApiKeyWithOrg");
      expect(source).not.toContain("requireAuthOrApiKeyWithOrg");
    });
  }

  for (const routePath of [
    "agents/[id]/a2a/route.ts",
    "agents/[id]/mcp/route.ts",
  ] as const) {
    test(`${routePath} uses cache-only scope and durable admission`, async () => {
      const source = await Bun.file(
        new URL(`../${routePath}`, import.meta.url),
      ).text();
      expect(source).toContain("getByIdCacheOnly");
      expect(source).toContain("requireGenerativeRouteCaller");
      expect(source).toContain("admitOrganizationInference");
      expect(source).not.toMatch(/from\s+["']@\/db\//);
      expect(source).not.toContain("creditsService.reserve");
      expect(source).not.toContain("requireUserOrApiKeyWithOrg");
      expect(source).toContain('app.post("/", async (c) =>');
    });
  }

  test("the combined resolver performs one inference decision lookup", async () => {
    const source = await Bun.file(
      new URL("../src/lib/generative-route-auth.ts", import.meta.url),
    ).text();
    expect(source.match(/resolveInferenceAuthContext\(/g)).toHaveLength(1);
    expect(source).toContain("cacheOnly: Boolean(executionCtx)");
    expect(source).toContain("cacheOnly: Boolean(resolution.ctx.admission)");
    expect(source).toContain("inferenceRateLimitConfig(");
  });

  test("only voice STT/TTS opt into bounded warming hydration", async () => {
    for (const routePath of [
      "v1/voice/tts/route.ts",
      "v1/voice/stt/route.ts",
    ]) {
      const source = await Bun.file(
        new URL(`../${routePath}`, import.meta.url),
      ).text();
      expect(source).toContain("awaitWarmingMs: 1500");
    }
    const chat = await Bun.file(
      new URL("../v1/generate-image/route.ts", import.meta.url),
    ).text();
    expect(chat).not.toContain("awaitWarmingMs");
  });
});
