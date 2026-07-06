/**
 * Cloud STT upstream URL resolution. `resolveCloudSttCandidateUrls` targets the
 * `/voice/stt` route on the same base URL as TTS and fans out the www/apex host
 * pair so a base written either way resolves; the ELIZAOS_CLOUD_BASE_URL env
 * override takes precedence over the built-in default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveCloudSttCandidateUrls } from "./server-cloud-tts";

describe("resolveCloudSttCandidateUrls", () => {
  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  });

  it("targets /voice/stt on the default cloud base", () => {
    const urls = resolveCloudSttCandidateUrls({});
    expect(urls).toContain("https://elizacloud.ai/api/v1/voice/stt");
    for (const url of urls) {
      expect(url.endsWith("/voice/stt")).toBe(true);
    }
  });

  it("honors ELIZAOS_CLOUD_BASE_URL and fans out the www/apex pair", () => {
    const urls = resolveCloudSttCandidateUrls({
      ELIZAOS_CLOUD_BASE_URL: "https://staging.example.com/api/v1",
    });
    expect(urls).toContain("https://staging.example.com/api/v1/voice/stt");
    expect(urls).toContain("https://www.staging.example.com/api/v1/voice/stt");
  });

  it("collapses a www base to include the apex host", () => {
    const urls = resolveCloudSttCandidateUrls({
      ELIZAOS_CLOUD_BASE_URL: "https://www.example.com/api/v1",
    });
    expect(urls).toContain("https://www.example.com/api/v1/voice/stt");
    expect(urls).toContain("https://example.com/api/v1/voice/stt");
  });
});
