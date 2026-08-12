/**
 * `config.env` is the designated escape hatch for sensitive process-env-only
 * material, so its write gate has to separate two things that look alike:
 * spawn injection primitives, which must never be persisted, and agent step-up
 * secrets, which are exactly what this file exists to hold.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistConfigEnv } from "./config-env.ts";

let stateDir: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-config-env-"));
  // persistConfigEnv mirrors every successful write into process.env, so the
  // accepted-key cases below would otherwise leak keys such as
  // ELIZA_CAPABILITY_ROUTER_ENABLED into the rest of the worker.
  envSnapshot = { ...process.env };
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
});

describe("persistConfigEnv rejects spawn injection primitives", () => {
  it.each([
    // exact keys from the core spawn denylist
    "GCONV_PATH",
    "BASH_ENV",
    "PYTHONPATH",
    "GIT_SSH_COMMAND",
    // prefix families, which the previous exact-only list could not express
    "NPM_CONFIG_REGISTRY",
    "DOCKER_HOST",
    "GIT_CONFIG_KEY_0",
    "BASH_FUNC_EXPLOIT",
  ])("rejects %s", async (key) => {
    await expect(persistConfigEnv(key, "x", { stateDir })).rejects.toThrow(
      /hijack vector/,
    );
  });

  it("still rejects the keys this file blocked before, including the two absent from core", async () => {
    for (const key of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "PATH",
      "DYLD_FALLBACK_FRAMEWORK_PATH",
      "DYLD_FALLBACK_LIBRARY_PATH",
    ]) {
      await expect(persistConfigEnv(key, "x", { stateDir })).rejects.toThrow(
        /hijack vector/,
      );
    }
  });

  it("rejects malformed keys before consulting either denylist", async () => {
    await expect(
      persistConfigEnv("lower_case", "x", { stateDir }),
    ).rejects.toThrow(/invalid key/);
  });
});

describe("persistConfigEnv still writes what config.env exists to hold", () => {
  it.each([
    // agent step-up secrets: on BLOCKED_ENV_KEYS for API writes, but this file
    // is their designated home — cloud-wallet.ts persists the first one here.
    "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
    "ELIZA_CLOUD_EVM_ADDRESS",
    "ELIZA_CLOUD_SOLANA_ADDRESS",
    "WALLET_SOURCE_EVM",
    "WALLET_SOURCE_SOLANA",
    "ENABLE_CLOUD_WALLET",
    "ELIZA_CAPABILITY_ROUTER_ENABLED",
    "ELIZA_CAPABILITY_ROUTER_URLS",
    "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
  ])("writes %s", async (key) => {
    await persistConfigEnv(key, "value", { stateDir });
    const contents = await readFile(path.join(stateDir, "config.env"), "utf8");
    expect(contents).toContain(`${key}=value`);
  });

  it.each([
    // vault-bootstrap scans config.env for keys matching _TOKEN / _API_KEY /
    // _PRIVATE_KEY and rewrites each as a vault reference *through this
    // function*. All of these are on the agent's BLOCKED_ENV_KEYS, so gating
    // on that predicate instead of core's would reject the migration this
    // bootstrap exists to perform.
    "ELIZA_API_TOKEN",
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "GITHUB_TOKEN",
    "STEWARD_API_KEY",
  ])("writes %s so vault-bootstrap can migrate it", async (key) => {
    await persistConfigEnv(key, "secret", { stateDir });
    const contents = await readFile(path.join(stateDir, "config.env"), "utf8");
    expect(contents).toContain(`${key}=secret`);
  });

  it("allows keys that only look like a blocked family", async () => {
    for (const key of [
      "UVICORN_HOST",
      "DOCKERFILE_PATH",
      "GIT_CONFIGURATION",
    ]) {
      await persistConfigEnv(key, "ok", { stateDir });
    }
    const contents = await readFile(path.join(stateDir, "config.env"), "utf8");
    expect(contents).toContain("UVICORN_HOST=ok");
    expect(contents).toContain("DOCKERFILE_PATH=ok");
    expect(contents).toContain("GIT_CONFIGURATION=ok");
  });
});
