/**
 * Eliza Cloud base-URL resolution. normalizeCloudSiteUrl collapses api/www host
 * aliases to the apex origin, strips query and hash, preserves loopback origins
 * but coerces other origins to https, and sanitizes malformed input rather than
 * echoing it back; resolveCloudApiBaseUrl appends the canonical /api/v1 path.
 * The ELIZAOS_CLOUD_BASE_URL env override takes precedence over the passed URL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  defaultCloudSiteUrl,
  isDevCloudTarget,
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "./base-url";

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

/**
 * The dev/production cloud split. `bun run dev` must not exercise production
 * credentials, billing, or agent state by default, so the unconfigured default
 * follows the entrypoint: staging from dev, production everywhere else. Staging
 * is a separate deployment with its own database and keys — crossing the
 * boundary by accident is the failure these cases exist to prevent.
 */
describe("default cloud target by environment", () => {
  const savedDevSource = process.env.ELIZA_DEV_SOURCE;

  afterEach(() => {
    if (savedDevSource === undefined) delete process.env.ELIZA_DEV_SOURCE;
    else process.env.ELIZA_DEV_SOURCE = savedDevSource;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.NODE_ENV;
  });

  it("defaults to staging under the dev entrypoint", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    expect(isDevCloudTarget()).toBe(true);
    expect(defaultCloudSiteUrl()).toBe("https://staging.elizacloud.ai");
    expect(resolveCloudApiBaseUrl()).toBe(
      "https://staging.elizacloud.ai/api/v1",
    );
  });

  it("defaults to production when the dev flag is absent", () => {
    delete process.env.ELIZA_DEV_SOURCE;
    expect(isDevCloudTarget()).toBe(false);
    expect(defaultCloudSiteUrl()).toBe("https://elizacloud.ai");
    expect(resolveCloudApiBaseUrl()).toBe("https://elizacloud.ai/api/v1");
  });

  it("ignores NODE_ENV=development — only the explicit dev flag counts", () => {
    // Test runners, benchmarks, and assorted tooling set NODE_ENV=development;
    // none of them should be silently re-pointed at staging.
    process.env.NODE_ENV = "development";
    delete process.env.ELIZA_DEV_SOURCE;
    expect(isDevCloudTarget()).toBe(false);
    expect(defaultCloudSiteUrl()).toBe("https://elizacloud.ai");
  });

  it('treats any value other than exactly "1" as not-dev', () => {
    for (const value of ["0", "", "true", "yes"]) {
      process.env.ELIZA_DEV_SOURCE = value;
      expect(isDevCloudTarget()).toBe(false);
    }
  });

  it("lets ELIZAOS_CLOUD_BASE_URL override the default in both directions", () => {
    // dev run pinned back to production
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://elizacloud.ai";
    expect(resolveCloudApiBaseUrl()).toBe("https://elizacloud.ai/api/v1");

    // non-dev run pointed at staging
    delete process.env.ELIZA_DEV_SOURCE;
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://staging.elizacloud.ai";
    expect(resolveCloudApiBaseUrl()).toBe(
      "https://staging.elizacloud.ai/api/v1",
    );
  });

  it("does not collapse staging into the production apex", () => {
    // api/www/apex are production aliases that normalize to the apex; staging
    // must NOT be swept into that set or dev would silently hit production.
    expect(normalizeCloudSiteUrl("https://staging.elizacloud.ai")).toBe(
      "https://staging.elizacloud.ai",
    );
    expect(normalizeCloudSiteUrl("https://api-staging.elizacloud.ai")).toBe(
      "https://api-staging.elizacloud.ai",
    );
  });
});
