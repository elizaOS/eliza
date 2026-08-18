/** Exercises Atlas image submit/download deadlines through an injected fetch boundary. */
import { describe, expect, it, mock } from "bun:test";

mock.module("../language-model", () => ({
  getAiProviderConfigurationError: () => "missing provider configuration",
}));

const { generateAtlasCloudImageWithFetch } = await import("../image/atlascloud-image-generation");

const request = {
  model: "atlas-test",
  prompt: "draw a bounded request",
  apiKeys: {
    ATLASCLOUD_API_KEY: "test-key",
    ATLASCLOUD_BASE_URL: "https://atlas.invalid",
  },
};

describe("Atlas image request deadlines", () => {
  it("aborts a stalled submit at the configured deadline", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected submit abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(generateAtlasCloudImageWithFetch(request, fetchImpl, 10)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("surfaces a provider error from a completed submit", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ msg: "quota exceeded" }, { status: 429 });

    await expect(generateAtlasCloudImageWithFetch(request, fetchImpl, 1_000)).rejects.toThrow(
      "quota exceeded",
    );
  });

  it("aborts a stalled prediction poll within the poll deadline", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount += 1;
      if (callCount === 1) {
        return Response.json({
          data: {
            id: "prediction-1",
            urls: { get: "https://atlas.invalid/prediction-1" },
          },
        });
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected poll abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };

    await expect(
      generateAtlasCloudImageWithFetch(request, fetchImpl, 1_000, {
        pollIntervalMs: 0,
        pollTimeoutMs: 100,
        pollRequestTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(callCount).toBe(2);
  });

  it("uses the injected fetch for submit and image download", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) {
        return Response.json({
          data: { outputs: ["https://images.invalid/result.png"] },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    };

    const image = await generateAtlasCloudImageWithFetch(request, fetchImpl, 1_000);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(image.mimeType).toBe("image/png");
    expect(image.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
