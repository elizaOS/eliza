/**
 * Eliza Cloud base-URL resolution. normalizeCloudSiteUrl collapses api/www host
 * aliases to the apex origin, strips query and hash, preserves loopback origins
 * but coerces other origins to https, and sanitizes malformed input rather than
 * echoing it back; resolveCloudApiBaseUrl appends the canonical /api/v1 path.
 * The ELIZAOS_CLOUD_BASE_URL env override takes precedence over the passed URL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { normalizeCloudSiteUrl, resolveCloudApiBaseUrl } from "./base-url";

describe("Eliza Cloud base URL normalization", () => {
  const savedConfig = getBootConfig();

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ACME_CLOUD_BASE_URL;
    setBootConfig(savedConfig);
  });

  it("normalizes every cloud host alias to the apex origin", () => {
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai")).toBe(
      "https://elizacloud.ai",
    );
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai/api/v1")).toBe(
      "https://elizacloud.ai",
    );
    expect(normalizeCloudSiteUrl("https://www.elizacloud.ai")).toBe(
      "https://elizacloud.ai",
    );
  });

  it("resolves canonical API paths from API host input", () => {
    expect(resolveCloudApiBaseUrl("https://api.elizacloud.ai")).toBe(
      "https://elizacloud.ai/api/v1",
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

  it("resolves branded env aliases without materializing the canonical key", () => {
    setBootConfig({
      ...savedConfig,
      envAliases: [["ACME_CLOUD_BASE_URL", "ELIZAOS_CLOUD_BASE_URL"]],
    });
    process.env.ACME_CLOUD_BASE_URL =
      "http://branded.example.com:8080/api/v1?debug=1";

    expect(resolveCloudApiBaseUrl()).toBe("https://branded.example.com/api/v1");
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBeUndefined();
  });
});
