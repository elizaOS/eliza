import { afterAll, expect, mock, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";

let attempts = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    attempts++;
    return Response.json(
      { error: { message: "retryable provider failure", type: "server_error" } },
      { status: 503 },
    );
  },
});
const provider = createOpenAI({
  apiKey: "local-test",
  baseURL: `http://127.0.0.1:${server.port}/v1`,
});
mock.module("../../providers/language-model", () => ({
  getLanguageModel: () => provider.chat("test-vision"),
  ProviderConfigurationError: class extends Error {},
}));
mock.module("../../security/safe-fetch", () => ({
  safeFetch: async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
}));
const { describeInboundImageMedia, InboundMediaDescriptionError } = await import(
  "./describe-inbound-media"
);
afterAll(() => {
  server.stop(true);
  mock.restore();
});

test("a retryable HTTP failure makes one SDK provider request and propagates a typed failure", async () => {
  let failure: unknown;
  try {
    await describeInboundImageMedia({ ELIZA_APP_INBOUND_MEDIA_VISION: "true" }, [
      "https://media.blooio.com/files/photo.jpg",
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(InboundMediaDescriptionError);
  expect((failure as InstanceType<typeof InboundMediaDescriptionError>).reason).toBe(
    "vision_model_failed",
  );
  expect(attempts).toBe(1);
}, 15000);
