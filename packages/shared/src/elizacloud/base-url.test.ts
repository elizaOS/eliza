/**
 * Eliza Cloud base-URL resolution separates the managed app and API origins,
 * collapses legacy aliases into their canonical environment, preserves custom
 * and loopback bases, and honors the ELIZAOS_CLOUD_BASE_URL override.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import {
  defaultCloudSiteUrl,
  isDevCloudTarget,
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
  resolveCloudRedirectScope,
} from "./base-url";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "./dev-cloud-env-authority";

describe("Eliza Cloud base URL normalization", () => {
  const savedConfig = getBootConfig();

  afterEach(() => {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ACME_CLOUD_BASE_URL;
    setBootConfig(savedConfig);
  });

  it("normalizes every production cloud alias to the managed app origin", () => {
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai")).toBe(
      "https://cloud.eliza.app",
    );
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai/api/v1")).toBe(
      "https://cloud.eliza.app",
    );
    expect(normalizeCloudSiteUrl("https://www.elizacloud.ai")).toBe(
      "https://cloud.eliza.app",
    );
    expect(normalizeCloudSiteUrl("https://eliza.app")).toBe(
      "https://cloud.eliza.app",
    );
  });

  it("resolves the canonical API origin independently from the app origin", () => {
    expect(resolveCloudApiBaseUrl("https://api.elizacloud.ai")).toBe(
      "https://api.eliza.app/api/v1",
    );
    expect(resolveCloudApiBaseUrl("https://cloud.eliza.app")).toBe(
      "https://api.eliza.app/api/v1",
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

describe("Cloud redirect scopes", () => {
  it("allows canonical HTTPS aliases only within the same deployment", () => {
    expect(resolveCloudRedirectScope("https://api.eliza.app")).toBe(
      resolveCloudRedirectScope("https://cloud.eliza.app"),
    );
    expect(resolveCloudRedirectScope("https://api-staging.eliza.app")).not.toBe(
      resolveCloudRedirectScope("https://cloud.eliza.app"),
    );
  });

  it("keeps hostile/custom origins distinct and rejects canonical HTTP", () => {
    expect(resolveCloudRedirectScope("https://attacker.example")).not.toBe(
      resolveCloudRedirectScope("https://api-staging.eliza.app"),
    );
    expect(resolveCloudRedirectScope("http://api.eliza.app")).toBeNull();
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
    expect(defaultCloudSiteUrl()).toBe("https://cloud-staging.eliza.app");
    expect(resolveCloudApiBaseUrl()).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
  });

  it("defaults to production when the dev flag is absent", () => {
    delete process.env.ELIZA_DEV_SOURCE;
    expect(isDevCloudTarget()).toBe(false);
    expect(defaultCloudSiteUrl()).toBe("https://cloud.eliza.app");
    expect(resolveCloudApiBaseUrl()).toBe("https://api.eliza.app/api/v1");
  });

  it("ignores NODE_ENV=development — only the explicit dev flag counts", () => {
    // Test runners, benchmarks, and assorted tooling set NODE_ENV=development;
    // none of them should be silently re-pointed at staging.
    process.env.NODE_ENV = "development";
    delete process.env.ELIZA_DEV_SOURCE;
    expect(isDevCloudTarget()).toBe(false);
    expect(defaultCloudSiteUrl()).toBe("https://cloud.eliza.app");
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
    expect(resolveCloudApiBaseUrl()).toBe("https://api.eliza.app/api/v1");

    // non-dev run pointed at staging
    delete process.env.ELIZA_DEV_SOURCE;
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://staging.elizacloud.ai";
    expect(resolveCloudApiBaseUrl()).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
  });

  it("keeps legacy staging aliases in the staging environment", () => {
    expect(normalizeCloudSiteUrl("https://staging.elizacloud.ai")).toBe(
      "https://cloud-staging.eliza.app",
    );
    expect(normalizeCloudSiteUrl("https://api-staging.elizacloud.ai")).toBe(
      "https://cloud-staging.eliza.app",
    );
  });
});

describe("launcher-authoritative cloud base URL", () => {
  const savedAuthorityEnv = {
    source: process.env.ELIZA_DEV_SOURCE,
    authority: process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY,
    target: process.env.ELIZA_DEV_CLOUD_TARGET,
    baseUrl: process.env.ELIZAOS_CLOUD_BASE_URL,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["ELIZA_DEV_SOURCE", savedAuthorityEnv.source],
      ["ELIZA_DEV_CLOUD_ENV_AUTHORITY", savedAuthorityEnv.authority],
      ["ELIZA_DEV_CLOUD_TARGET", savedAuthorityEnv.target],
      ["ELIZAOS_CLOUD_BASE_URL", savedAuthorityEnv.baseUrl],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("keeps the staging-explicit launch base after process.env is polluted", () => {
    resetDevCloudEnvAuthorityForTests();
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(normalizeCloudSiteUrl()).toBe("https://cloud-staging.eliza.app");
    expect(resolveCloudApiBaseUrl()).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
  });

  it("keeps the self-hosted launch base after process.env is polluted", () => {
    resetDevCloudEnvAuthorityForTests();
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
    delete process.env.ELIZA_DEV_CLOUD_TARGET;
    process.env.ELIZAOS_CLOUD_BASE_URL = "http://localhost:8787/api/v1";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(normalizeCloudSiteUrl()).toBe("http://localhost:8787");
    expect(resolveCloudApiBaseUrl()).toBe("http://localhost:8787/api/v1");
  });

  it("preserves an accepted LAN HTTP origin and port for self-hosted authority", () => {
    resetDevCloudEnvAuthorityForTests();
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
    delete process.env.ELIZA_DEV_CLOUD_TARGET;
    process.env.ELIZAOS_CLOUD_BASE_URL = "http://192.168.1.20:8787/api/v1";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(normalizeCloudSiteUrl()).toBe("http://192.168.1.20:8787");
    expect(resolveCloudApiBaseUrl()).toBe("http://192.168.1.20:8787/api/v1");
  });
});
