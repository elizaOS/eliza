import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCloudApiKeysUrl,
  resolveCloudBillingUrl,
} from "../cloud/base-url.js";
import { handleCloudStatusRoutes as handleAutonomousCloudStatusRoutes } from "./cloud-status-routes-autonomous.js";
import { handleCloudStatusRoutes } from "./cloud-status-routes.js";

const authorityEnvKeys = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const originalAuthorityEnv = Object.fromEntries(
  authorityEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof authorityEnvKeys)[number], string | undefined>;

function installStagingAuthority(): void {
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
  process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
  process.env.ELIZAOS_CLOUD_API_KEY = "launcher-staging-key";
  process.env.ELIZAOS_CLOUD_BASE_URL =
    "https://api-staging.eliza.app/api/v1";
  captureDevCloudEnvAuthoritySnapshot();

  process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
  process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
}

async function readStatusBody(
  handler: typeof handleCloudStatusRoutes,
): Promise<Record<string, unknown>> {
  const json = vi.fn();
  const handled = await handler({
    req: {} as never,
    res: {} as never,
    method: "GET",
    pathname: "/api/cloud/status",
    config: {
      cloud: {
        apiKey: "persisted-production-key",
        baseUrl: "https://api.eliza.app/api/v1",
      },
    },
    runtime: null,
    json,
  });
  expect(handled).toBe(true);
  expect(json).toHaveBeenCalledOnce();
  return json.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("Cloud status billing URL authority", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    for (const key of authorityEnvKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of authorityEnvKeys) {
      const value = originalAuthorityEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it.each([
    ["shared status", handleCloudStatusRoutes],
    ["autonomous status", handleAutonomousCloudStatusRoutes],
  ] as const)("keeps %s top-up links on staging", async (_name, handler) => {
    installStagingAuthority();

    const body = await readStatusBody(
      handler as unknown as typeof handleCloudStatusRoutes,
    );

    expect(body).toMatchObject({
      connected: true,
      hasApiKey: true,
      topUpUrl: "https://cloud-staging.eliza.app/cloud/billing",
    });
  });

  it("uses a valid self-hosted site for billing", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
    process.env.ELIZAOS_CLOUD_BASE_URL = "http://localhost:8787/api/v1";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(resolveCloudBillingUrl("https://api.eliza.app/api/v1")).toBe(
      "http://localhost:8787/cloud/billing",
    );
    expect(resolveCloudApiKeysUrl("https://api.eliza.app/api/v1")).toBe(
      "http://localhost:8787/cloud/api-keys",
    );
  });

  it("keeps API-key management on staging after late endpoint pollution", () => {
    installStagingAuthority();

    expect(resolveCloudApiKeysUrl("https://api.eliza.app/api/v1")).toBe(
      "https://cloud-staging.eliza.app/cloud/api-keys",
    );
  });
});
