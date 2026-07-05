/**
 * Issue #13422 P8 slice: the aliased env reads migrated to the alias-aware
 * reader across the elizacloud / matrix / streaming / coding-tools plugins must
 * resolve a NON-ELIZA brand prefix (MILADY_*) WITHOUT the process.env alias-sync
 * mirror, with the canonical ELIZA_* key still winning when both are set and an
 * empty branded value reading as unset. Drives the real migrated
 * `isCloudProvisionedContainer()` for its two keys and asserts the shared
 * `readAliasedEnv` contract for the remaining P8 keys (platform, state dir, the
 * cloud-TTS toggle). A NON-ELIZA prefix is the security-relevant fixture: an
 * ELIZA->ELIZA self-mirror would prove nothing.
 */
import {
  buildBrandEnvAliases,
  getBootConfig,
  readAliasedEnv,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloudProvisionedContainer } from "../../src/routes/cloud-provisioning";

const BRAND = "MILADY";

// Every P8 canonical key + its branded alias, plus the other env vars
// `isCloudProvisionedContainer` consults, tracked so each case starts clean.
const TRACKED = [
  "MILADY_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_PROVISIONED",
  "MILADY_API_TOKEN",
  "ELIZA_API_TOKEN",
  "MILADY_PLATFORM",
  "ELIZA_PLATFORM",
  "MILADY_STATE_DIR",
  "ELIZA_STATE_DIR",
  "MILADY_CLOUD_TTS_DISABLED",
  "ELIZA_CLOUD_TTS_DISABLED",
  "STEWARD_AGENT_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
];

describe("issue #13422 P8 aliased reads resolve a branded prefix with zero mirror writes", () => {
  const savedConfig = getBootConfig();
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TRACKED) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Pin the alias table on the immutable BootConfig, as the app boot path does.
    setBootConfig({ ...savedConfig, envAliases: buildBrandEnvAliases(BRAND) });
  });

  afterEach(() => {
    for (const key of TRACKED) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setBootConfig(savedConfig);
  });

  it("isCloudProvisionedContainer resolves branded flag + token, no ELIZA_ mirror", () => {
    process.env.MILADY_CLOUD_PROVISIONED = "1";
    process.env.MILADY_API_TOKEN = "milady-inbound-token";
    const before = { ...process.env };

    expect(isCloudProvisionedContainer()).toBe(true);

    // A read must never materialize the ELIZA_ target — that mutation is exactly
    // what #13422 removes the dependency on.
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("canonical ELIZA_CLOUD_PROVISIONED wins over the branded alias", () => {
    // Canonical "0" beats branded "1": provisioning gate stays closed.
    process.env.ELIZA_CLOUD_PROVISIONED = "0";
    process.env.MILADY_CLOUD_PROVISIONED = "1";
    process.env.MILADY_API_TOKEN = "milady-inbound-token";
    expect(readAliasedEnv("ELIZA_CLOUD_PROVISIONED")).toBe("0");
    expect(isCloudProvisionedContainer()).toBe(false);
  });

  it("an empty branded flag reads as unset (normalizeEnvValue contract)", () => {
    process.env.MILADY_CLOUD_PROVISIONED = "   ";
    process.env.MILADY_API_TOKEN = "milady-inbound-token";
    expect(readAliasedEnv("ELIZA_CLOUD_PROVISIONED")).toBeUndefined();
    expect(isCloudProvisionedContainer()).toBe(false);
  });

  it("readAliasedEnv resolves platform / state-dir / cloud-TTS from branded keys, no mirror", () => {
    process.env.MILADY_PLATFORM = "android";
    process.env.MILADY_STATE_DIR = "/var/milady/state";
    process.env.MILADY_CLOUD_TTS_DISABLED = "true";
    const before = { ...process.env };

    expect(readAliasedEnv("ELIZA_PLATFORM")).toBe("android");
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/milady/state");
    expect(readAliasedEnv("ELIZA_CLOUD_TTS_DISABLED")).toBe("true");

    expect(process.env.ELIZA_PLATFORM).toBeUndefined();
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
    expect(process.env.ELIZA_CLOUD_TTS_DISABLED).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("canonical ELIZA_ keys win over branded aliases for platform / cloud-TTS", () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.MILADY_PLATFORM = "android";
    process.env.ELIZA_CLOUD_TTS_DISABLED = "false";
    process.env.MILADY_CLOUD_TTS_DISABLED = "true";
    expect(readAliasedEnv("ELIZA_PLATFORM")).toBe("ios");
    expect(readAliasedEnv("ELIZA_CLOUD_TTS_DISABLED")).toBe("false");
  });

  it("an empty branded state dir reads as unset", () => {
    process.env.MILADY_STATE_DIR = "   ";
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBeUndefined();
  });
});
