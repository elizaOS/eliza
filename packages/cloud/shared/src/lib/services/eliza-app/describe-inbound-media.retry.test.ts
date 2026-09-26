import { expect, mock, test } from "bun:test";
import { APICallError } from "ai";

let attempts = 0;
mock.module("../../providers/language-model", () => ({
  ProviderConfigurationError: class extends Error {},
  getLanguageModel: () => ({
    specificationVersion: "v3",
    provider: "local-test",
    modelId: "vision",
    supportedUrls: {},
    doGenerate: async () => {
      attempts += 1;
      throw new APICallError({
        message: "provider unavailable",
        url: "https://fixture.invalid",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    },
  }),
}));
mock.module("../../security/safe-fetch", () => ({
  safeFetch: async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }),
}));
const { describeInboundImageMedia } = await import("./describe-inbound-media");

test("a retryable vision failure spends only the single admitted provider attempt", async () => {
  try {
    await expect(
      describeInboundImageMedia({ ELIZA_APP_INBOUND_MEDIA_VISION: "true" }, [
        "https://media.blooio.com/fixture.png",
      ]),
    ).rejects.toMatchObject({ reason: "vision_model_failed" });
    expect(attempts).toBe(1);
  } finally {
    mock.restore();
  }
});
