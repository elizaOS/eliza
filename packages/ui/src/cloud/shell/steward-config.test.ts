/**
 * Unit coverage for Steward config resolution (API URL / tenant overrides). Env
 * mocked, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredStewardApiUrlOverride,
  configuredStewardTenantId,
} from "./steward-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuredStewardTenantId", () => {
  it("prefers the Vite-exposed Steward tenant for browser bundles", () => {
    vi.stubEnv("VITE_STEWARD_TENANT_ID", " elizacloud-staging ");
    vi.stubEnv("NEXT_PUBLIC_STEWARD_TENANT_ID", "elizacloud");

    expect(configuredStewardTenantId("elizacloud")).toBe("elizacloud-staging");
  });

  it("keeps the legacy NEXT_PUBLIC tenant as a fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_STEWARD_TENANT_ID", "elizacloud-staging");

    expect(configuredStewardTenantId("elizacloud")).toBe("elizacloud-staging");
  });

  it("uses the fallback when the configured tenant is missing or placeholder", () => {
    vi.stubEnv("VITE_STEWARD_TENANT_ID", "your_steward_tenant_id");

    expect(configuredStewardTenantId("elizacloud")).toBe("elizacloud");
  });
});

describe("configuredStewardApiUrlOverride", () => {
  it("prefers the Vite-exposed Steward API override", () => {
    vi.stubEnv(
      "VITE_STEWARD_API_URL",
      " https://api-staging.elizacloud.ai/steward ",
    );
    vi.stubEnv("NEXT_PUBLIC_STEWARD_API_URL", "https://api.elizacloud.ai");

    expect(configuredStewardApiUrlOverride()).toBe(
      "https://api-staging.elizacloud.ai/steward",
    );
  });

  it("ignores placeholder Steward API overrides", () => {
    vi.stubEnv("VITE_STEWARD_API_URL", "https://your_steward_api_url");

    expect(configuredStewardApiUrlOverride()).toBeUndefined();
  });
});
