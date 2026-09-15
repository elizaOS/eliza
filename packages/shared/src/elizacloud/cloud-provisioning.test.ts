/**
 * Cloud container provisioning detection. The tests cover both legacy canonical
 * env names and boot-configured brand aliases, proving the shared detector can
 * run before alias sync writes have materialized compatibility keys.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config.js";
import { isCloudProvisionedContainer } from "./cloud-provisioning.js";
import { resetDevCloudEnvAuthorityForTests } from "./dev-cloud-env-authority.js";

const CLOUD_PROVISIONING_KEYS = [
  "ACME_API_TOKEN",
  "ACME_CLOUD_API_KEY",
  "ACME_CLOUD_ENABLED",
  "ACME_CLOUD_PROVISIONED",
  "ELIZA_API_TOKEN",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZA_DEV_SOURCE",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
] as const;

describe("isCloudProvisionedContainer", () => {
  const savedConfig = getBootConfig();
  const savedEnv = Object.fromEntries(
    CLOUD_PROVISIONING_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    setBootConfig(savedConfig);
    for (const key of CLOUD_PROVISIONING_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    setBootConfig(savedConfig);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("requires the cloud flag plus at least one provisioning credential", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isCloudProvisionedContainer()).toBe(false);

    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isCloudProvisionedContainer()).toBe(true);
  });

  it("accepts a branded API-token alias without materializing ELIZA_API_TOKEN", () => {
    setBootConfig({
      ...savedConfig,
      envAliases: [
        ["ACME_CLOUD_PROVISIONED", "ELIZA_CLOUD_PROVISIONED"],
        ["ACME_API_TOKEN", "ELIZA_API_TOKEN"],
      ],
    });
    process.env.ACME_CLOUD_PROVISIONED = "1";
    process.env.ACME_API_TOKEN = "owner-token";

    expect(isCloudProvisionedContainer()).toBe(true);
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("accepts branded cloud API-key provisioning aliases without env sync", () => {
    setBootConfig({
      ...savedConfig,
      envAliases: [
        ["ACME_CLOUD_PROVISIONED", "ELIZA_CLOUD_PROVISIONED"],
        ["ACME_CLOUD_ENABLED", "ELIZAOS_CLOUD_ENABLED"],
        ["ACME_CLOUD_API_KEY", "ELIZAOS_CLOUD_API_KEY"],
      ],
    });
    process.env.ACME_CLOUD_PROVISIONED = "1";
    process.env.ACME_CLOUD_ENABLED = "true";
    process.env.ACME_CLOUD_API_KEY = "cloud-key";

    expect(isCloudProvisionedContainer()).toBe(true);
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
  });

  it.each(["staging-default", "offline"] as const)(
    "forces %s to stay unprovisioned despite launch-time and late credential pollution",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.STEWARD_AGENT_TOKEN = "inherited-production-token";

      expect(isCloudProvisionedContainer()).toBe(false);

      process.env.ELIZA_API_TOKEN = "late-production-token";
      process.env.ELIZAOS_CLOUD_ENABLED = "true";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";

      expect(isCloudProvisionedContainer()).toBe(false);
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "%s cannot become provisioned through late env pollution",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;

      expect(isCloudProvisionedContainer()).toBe(false);

      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.ELIZAOS_CLOUD_ENABLED = "true";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-cloud-key";
      process.env.STEWARD_AGENT_TOKEN = "late-steward-token";

      expect(isCloudProvisionedContainer()).toBe(false);
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "%s keeps its launch-time provisioned classification after late clearing",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.ELIZA_API_TOKEN = "launch-api-token";

      expect(isCloudProvisionedContainer()).toBe(true);

      delete process.env.ELIZA_CLOUD_PROVISIONED;
      delete process.env.ELIZA_API_TOKEN;

      expect(isCloudProvisionedContainer()).toBe(true);
    },
  );
});
