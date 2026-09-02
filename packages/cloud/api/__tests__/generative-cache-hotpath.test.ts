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

const providerBackedRouteCall =
  /\b(?:admitOrganizationInference|admitFlatGenerativeOperation|admitAppInference(?:CacheOnly)?|run(?:Flat|Metered)ProviderOperation|handle(?:ChatCompletions|GenerateImage)POST|runAppReview|promoteApp|generateAssetBundle|postAppTweet|postAnnouncement|generateAppTweet|generateAnnouncement)\s*\(/;

function callCount(source: string, symbol: string): number {
  return [...source.matchAll(new RegExp(`\\b${symbol}\\s*\\(`, "g"))].length;
}

/**
 * A route which defers its strong credential proof must keep auth, guard, and
 * the lazy admission handoff in one handler in that order. A route without the
 * deferred option retains the eager strong check and therefore has no guard.
 */
function expectFusedDeferredCredentialRoute(source: string, routePath: string) {
  const callerCount = callCount(source, "requireGenerativeRouteCaller");
  if (callerCount === 0) return;

  expect(callerCount, `${routePath} must resolve its caller once`).toBe(1);
  const defersCredential = source.includes("deferStrongCredentialCheck");
  const guardCount = callCount(source, "deferredCredentialAdmissionGuard");
  if (!defersCredential) {
    expect(
      guardCount,
      `${routePath} must not orphan a guard from eager auth`,
    ).toBe(0);
    return;
  }

  expect(
    guardCount,
    `${routePath} must create one deferred credential guard`,
  ).toBe(1);
  expect(
    callCount(source, "credentialForAdmission"),
    `${routePath} must hand the deferred proof to admission`,
  ).toBeGreaterThan(0);
  const callerOffset = source.indexOf("requireGenerativeRouteCaller(");
  const guardOffset = source.indexOf("deferredCredentialAdmissionGuard(");
  const admissionOffset = source.indexOf("credentialForAdmission(");
  expect(
    guardOffset,
    `${routePath} must create its guard after authenticating the caller`,
  ).toBeGreaterThan(callerOffset);
  expect(
    admissionOffset,
    `${routePath} must consume the lazy proof after creating its guard`,
  ).toBeGreaterThan(guardOffset);
}

describe("canonical generative cache-only hot path", () => {
  test("reverse-inventories direct, flat-operation, and delegated provider routes behind shared auth", async () => {
    const routeRoot = new URL("../", import.meta.url);
    const sharedAuthOrCanonicalDelegate =
      /\b(?:requireGenerativeRouteCaller|resolveInferenceAuthContext|handleChatCompletionsPOST|handleGenerateImagePOST)\b/;
    const providerBackedRoutes: string[] = [];

    for await (const routePath of new Bun.Glob("**/route.ts").scan({
      cwd: routeRoot.pathname,
    })) {
      const source = await Bun.file(new URL(routePath, routeRoot)).text();
      if (!providerBackedRouteCall.test(source)) continue;
      providerBackedRoutes.push(routePath);
      expect(source, routePath).toMatch(sharedAuthOrCanonicalDelegate);
      expectFusedDeferredCredentialRoute(source, routePath);
    }

    expect(providerBackedRoutes).toContain(
      "elevenlabs/voices/verify/[id]/route.ts",
    );
    expect(providerBackedRoutes).toContain("v1/apps/[id]/chat/route.ts");
    expect(providerBackedRoutes).toContain("v1/apps/[id]/review/route.ts");
    expect(providerBackedRoutes).toContain("v1/generate-image/route.ts");
  });

  test("detects a deferred provider route that bypasses the credential guard", () => {
    const bypassedRoute = `
      async function post(c) {
        const caller = await requireGenerativeRouteCaller(c, {
          deferStrongCredentialCheck: true,
        });
        return runFlatProviderOperation(caller, operation, dispatch);
      }
    `;

    expect(() =>
      expectFusedDeferredCredentialRoute(bypassedRoute, "fixture/route.ts"),
    ).toThrow(/deferred credential guard/);
  });

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
      expect(source).toContain("deferStrongCredentialCheck: true");
      expect(source).toContain("deferredCredentialAdmissionGuard");
      expect(source).toContain("credentialForAdmission");
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
