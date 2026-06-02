import { afterEach, describe, expect, it } from "vitest";
import { normalizeCloudSiteUrl, resolveCloudApiBaseUrl } from "./base-url";

describe("Eliza Cloud base URL normalization", () => {
  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  });

  it("normalizes the API host back to the browser site host", () => {
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai",
    );
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai/api/v1")).toBe(
      "https://www.elizacloud.ai",
    );
  });

  it("resolves canonical API paths from API host input", () => {
    expect(resolveCloudApiBaseUrl("https://api.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai/api/v1",
    );
  });

  it("strips query and hash components from configured origins", () => {
    expect(
      normalizeCloudSiteUrl("https://custom.example.com/path/api/v1?x=1#hash"),
    ).toBe("https://custom.example.com/path");
  });

  it("preserves loopback origins while coercing non-loopback origins to https", () => {
    expect(normalizeCloudSiteUrl("http://localhost:3000/api/v1")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeCloudSiteUrl("http://custom.example.com:8080/api/v1")).toBe(
      "https://custom.example.com",
    );
  });

  it("sanitizes malformed URL fallback instead of returning raw input", () => {
    expect(
      normalizeCloudSiteUrl("http://127.999.999.999:8080/api/v1?x=1#hash"),
    ).toBe("https://127.999.999.999:8080");
  });

  it("prefers isolated env override over raw URL", () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "http://env.example.com:8080/api/v1?debug=1";

    expect(normalizeCloudSiteUrl("https://raw.example.com")).toBe(
      "https://env.example.com",
    );
  });
});
