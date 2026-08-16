/**
 * Deterministic unit coverage for the Cloud-live API-origin contract (#18076).
 * Real resolver from @elizaos/shared; process.env override saved/restored so
 * the internal ELIZAOS_CLOUD_BASE_URL read stays consistent with injected env.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCloudLiveOriginContract } from "./cloud-live-origin";

const STAGING_API = "https://api-staging.eliza.app";
const PRODUCTION_API = "https://api.eliza.app";

const SAVED = {
  base: process.env.ELIZAOS_CLOUD_BASE_URL,
  dev: process.env.ELIZA_DEV_SOURCE,
};

function setBaseUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.ELIZAOS_CLOUD_BASE_URL;
  else process.env.ELIZAOS_CLOUD_BASE_URL = value;
}

describe("resolveCloudLiveOriginContract (#18076)", () => {
  beforeEach(() => {
    setBaseUrl(undefined);
    // The dev flag flips the unconfigured default to staging; these contracts
    // assert the CI shape, where it is unset.
    delete process.env.ELIZA_DEV_SOURCE;
  });

  afterEach(() => {
    setBaseUrl(SAVED.base);
    if (SAVED.dev === undefined) delete process.env.ELIZA_DEV_SOURCE;
    else process.env.ELIZA_DEV_SOURCE = SAVED.dev;
  });

  it("resolves the production origin by default and passes when unpinned", () => {
    const contract = resolveCloudLiveOriginContract({});
    expect(contract.origin).toBe(PRODUCTION_API);
    expect(contract.environment).toBe("production");
    expect(contract.expected).toBeNull();
    expect(contract.ok).toBe(true);
  });

  it("accepts an explicitly pinned staging origin", () => {
    setBaseUrl(STAGING_API);
    const contract = resolveCloudLiveOriginContract({
      ELIZAOS_CLOUD_BASE_URL: STAGING_API,
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
    });
    expect(contract.origin).toBe(STAGING_API);
    expect(contract.environment).toBe("staging");
    expect(contract.ok).toBe(true);
  });

  it("fails closed when staging is expected but no base URL was pinned", () => {
    const contract = resolveCloudLiveOriginContract({
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
    });
    expect(contract.ok).toBe(false);
    expect(contract.reason).toContain("refusing the production default");
  });

  it("fails closed when staging is expected but production is resolved", () => {
    setBaseUrl(PRODUCTION_API);
    const contract = resolveCloudLiveOriginContract({
      ELIZAOS_CLOUD_BASE_URL: PRODUCTION_API,
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
    });
    expect(contract.ok).toBe(false);
    expect(contract.environment).toBe("production");
    expect(contract.reason).toContain("expected the staging Cloud API");
  });

  it("asserts production when the production lane pins its expectation", () => {
    const contract = resolveCloudLiveOriginContract({
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "production",
    });
    expect(contract.ok).toBe(true);
    expect(contract.environment).toBe("production");
  });

  it("rejects an unknown expected-environment value instead of guessing", () => {
    const contract = resolveCloudLiveOriginContract({
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "prod",
    });
    expect(contract.ok).toBe(false);
    expect(contract.reason).toContain('must be "staging" or "production"');
  });

  it("fails closed when production is expected but staging is resolved", () => {
    setBaseUrl(STAGING_API);
    const contract = resolveCloudLiveOriginContract({
      ELIZAOS_CLOUD_BASE_URL: STAGING_API,
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "production",
    });
    expect(contract.ok).toBe(false);
    expect(contract.environment).toBe("staging");
  });
});
