// Regression tests: FAL_API_KEY is canonical over the legacy FAL_KEY alias
// (#28935). These pin the precedence so a future promotion cannot silently
// prefer the legacy key again.
import { describe, expect, test } from "bun:test";
import { generateFalImageWithFetch } from "./fal-image-generation";
import type { ImageGenRequest } from "./types";

function makeRequest(apiKeys: Record<string, string | undefined>): ImageGenRequest {
  return {
    model: "fal-ai/flux/dev",
    prompt: "a red cube",
    apiKeys,
    actor: { organizationId: "org", userId: "user", apiKeyId: null },
  } as unknown as ImageGenRequest;
}

describe("FAL credential precedence", () => {
  test("FAL_API_KEY wins when both keys are present", async () => {
    let captured: string | null = null;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      captured = headers["Authorization"] ?? null;
      return new Response(JSON.stringify({ images: [{ url: "https://example/x.png" }] }));
    };

    await generateFalImageWithFetch(
      makeRequest({ FAL_KEY: "stale-legacy-key", FAL_API_KEY: "canonical-key" }),
      fetchImpl as typeof fetch,
    );

    expect(captured).toContain("canonical-key");
    expect(captured).not.toContain("stale-legacy-key");
  });

  test("FAL_KEY is used only as a fallback when FAL_API_KEY is absent", async () => {
    let captured: string | null = null;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      captured = headers["Authorization"] ?? null;
      return new Response(JSON.stringify({ images: [{ url: "https://example/x.png" }] }));
    };

    await generateFalImageWithFetch(
      makeRequest({ FAL_KEY: "legacy-only" }),
      fetchImpl as typeof fetch,
    );

    expect(captured).toContain("legacy-only");
  });

  test("missing keys throw the configuration error", async () => {
    const fetchImpl = async () => new Response("{}");
    await expect(
      generateFalImageWithFetch(makeRequest({}), fetchImpl as typeof fetch),
    ).rejects.toThrow();
  });
});
