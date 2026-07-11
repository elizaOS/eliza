import { describe, expect, it } from "vitest";
import { resolveDirectCloudTtsRequest } from "./direct-cloud-tts";

describe("resolveDirectCloudTtsRequest", () => {
  it("routes authenticated cloud TTS directly to the configured worker", () => {
    expect(
      resolveDirectCloudTtsRequest({
        cloudApiBase: "https://staging.elizacloud.ai/",
        cloudAuthToken: " session-token ",
      }),
    ).toEqual({
      url: "https://api-staging.elizacloud.ai/api/v1/voice/tts",
      authToken: "session-token",
    });
  });

  it("preserves custom cloud API origins", () => {
    expect(
      resolveDirectCloudTtsRequest({
        cloudApiBase: "https://cloud.example.test/prefix/",
        cloudAuthToken: "token",
      }),
    ).toEqual({
      url: "https://cloud.example.test/prefix/api/v1/voice/tts",
      authToken: "token",
    });
  });

  it("does not duplicate an existing API root", () => {
    expect(
      resolveDirectCloudTtsRequest({
        cloudApiBase: "https://cloud.example.test/api/v1/",
        cloudAuthToken: "token",
      })?.url,
    ).toBe("https://cloud.example.test/api/v1/voice/tts");
  });

  it("falls back when cloud auth or configuration is unavailable", () => {
    expect(
      resolveDirectCloudTtsRequest({
        cloudApiBase: "https://staging.elizacloud.ai",
        cloudAuthToken: " ",
      }),
    ).toBeNull();
    expect(
      resolveDirectCloudTtsRequest({
        cloudApiBase: undefined,
        cloudAuthToken: "token",
      }),
    ).toBeNull();
  });
});
