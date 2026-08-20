/** Exercises Fal generation and download deadlines through an injected fetch boundary. */
import { describe, expect, it, mock } from "bun:test";

mock.module("../language-model", () => ({
  getAiProviderConfigurationError: () => "missing provider configuration",
}));

const { generateFalImageWithFetch } = await import("../image/fal-image-generation");

const request = {
  model: "fal-ai/flux/dev",
  prompt: "draw a bounded request",
  apiKeys: { FAL_KEY: "test-key", FAL_RUN_BASE_URL: "https://fal.invalid" },
};

describe("Fal image request deadlines", () => {
  it("aborts a stalled synchronous generation at the configured job deadline", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected generation abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(generateFalImageWithFetch(request, fetchImpl, 10)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("uses the injected fetch for both generation and image download", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) {
        return Response.json({ images: [{ url: "https://images.invalid/result.png" }] });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    };

    const image = await generateFalImageWithFetch(request, fetchImpl, 1_000);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
