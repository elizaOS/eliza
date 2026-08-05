/**
 * Guards the canonical voice and media routes against reintroducing database
 * authorization or credit reservation before provider dispatch. This is a
 * deterministic source-contract tripwire; route behavior is covered by each
 * provider suite.
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
      expect(source).not.toContain("requireUserOrApiKeyWithOrg");
      expect(source).not.toContain("requireAuthOrApiKeyWithOrg");
      expect(source).not.toContain("reserveFlatUsageCredits");
    });
  }

  test("the combined resolver performs one inference decision lookup", async () => {
    const source = await Bun.file(
      new URL("../src/lib/generative-route-auth.ts", import.meta.url),
    ).text();
    expect(source.match(/resolveInferenceAuthContext\(/g)).toHaveLength(1);
    expect(source).toContain("cacheOnly: Boolean(executionCtx)");
  });
});
