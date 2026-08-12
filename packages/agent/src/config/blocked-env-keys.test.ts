/**
 * Verifies BLOCKED_ENV_KEYS is the single secret-key denylist shared by API env
 * writes and startup env collection: it must be the same Set instance the
 * plugin-discovery helpers use, cover the canonical secret keys, and make
 * collectConfigEnvVars drop those keys while passing safe ones through.
 *
 * Also verifies BLOCKED_ENV_KEYS is a superset of the core spawn-env policy so
 * the config-write boundary and the spawn sanitizer cannot drift.
 * Deterministic, no live services.
 */

import { BLOCKED_SPAWN_ENV_KEYS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_ENV_KEY_PREFIXES,
  BLOCKED_ENV_KEYS,
  isBlockedEnvKey,
} from "./blocked-env-keys";
import { collectConfigEnvVars } from "./env-vars";

describe("BLOCKED_ENV_KEYS", () => {
  it("is the canonical union used by API writes and startup env sync", async () => {
    const pluginDiscovery = await import("../api/plugin-discovery-helpers");

    expect(pluginDiscovery.BLOCKED_ENV_KEYS).toBe(BLOCKED_ENV_KEYS);
    expect(BLOCKED_ENV_KEYS.has("STEWARD_API_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("STEWARD_AGENT_TOKEN")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("ELIZA_CLOUD_CLIENT_ADDRESS_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("OPINION_API_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("OPINION_PRIVATE_KEY")).toBe(true);
  });

  it("is a superset of BLOCKED_SPAWN_ENV_KEYS so the two denylists cannot drift", () => {
    for (const key of BLOCKED_SPAWN_ENV_KEYS) {
      expect(BLOCKED_ENV_KEYS.has(key)).toBe(true);
    }
    // Spot-check keys from the original PR and the review follow-up
    expect(BLOCKED_ENV_KEYS.has("JAVA_TOOL_OPTIONS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("JDK_JAVA_OPTIONS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_SSH_COMMAND")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_SSH")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_ASKPASS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_CONFIG_COUNT")).toBe(true);
  });

  it("isBlockedEnvKey catches indexed prefix families that exact-match misses", () => {
    // These are prefix-matched and would be missed by BLOCKED_ENV_KEYS.has()
    expect(isBlockedEnvKey("GIT_CONFIG_KEY_0")).toBe(true);
    expect(isBlockedEnvKey("GIT_CONFIG_VALUE_99")).toBe(true);
    expect(isBlockedEnvKey("NPM_CONFIG_REGISTRY")).toBe(true);
    expect(isBlockedEnvKey("UV_INDEX_URL")).toBe(true);
    // Exact-match keys still work
    expect(isBlockedEnvKey("LD_PRELOAD")).toBe(true);
    expect(isBlockedEnvKey("JAVA_TOOL_OPTIONS")).toBe(true);
    // Benign keys pass through
    expect(isBlockedEnvKey("GIT_AUTHOR_NAME")).toBe(false);
    expect(isBlockedEnvKey("NODE_ENV")).toBe(false);
  });

  it("mirrors core's spawn prefix families so the two paths cannot drift", async () => {
    // BLOCKED_SPAWN_ENV_PREFIXES guards a caller-supplied child environment.
    // These prefixes guard config/API writes, which reach process.env and are
    // then inherited by every spawn site that passes no explicit env.
    const { BLOCKED_SPAWN_ENV_PREFIXES } = await import(
      "@elizaos/core/security/spawn-env-policy"
    );
    const missing = [...BLOCKED_SPAWN_ENV_PREFIXES].filter(
      (prefix) => !BLOCKED_ENV_KEY_PREFIXES.includes(prefix),
    );
    expect(missing).toEqual([]);
  });

  it("blocks any key inside a dangerous prefix family", () => {
    for (const key of [
      "BASH_FUNC_x%%",
      "bash_func_payload",
      "NPM_CONFIG_REGISTRY",
      "PNPM_STORE_DIR",
      "YARN_RC_FILENAME",
      "BUN_CONFIG_REGISTRY",
      "UV_INDEX_URL",
      "PIP_INDEX_URL",
      "PIPX_HOME",
      "PYX_CACHE",
      "DENO_DIR",
      "DOCKER_HOST",
      "PODMAN_CONNECTION",
    ]) {
      expect(isBlockedEnvKey(key)).toBe(true);
    }
  });

  it("matches whole prefixes only, not any key that merely starts alike", () => {
    // Each of these shares a leading substring with a blocked family but is not
    // inside it — the trailing underscore is what makes the family a namespace.
    for (const key of [
      "UVICORN_HOST",
      "PIPELINE_URL",
      "DENOISE_LEVEL",
      "DOCKERFILE_PATH",
      "BASH_FUNCTION_NAME",
      "YARNSPINNER_MODE",
    ]) {
      expect(isBlockedEnvKey(key)).toBe(false);
    }
  });

  it("does not let a whitespace variant slip past either check", () => {
    expect(isBlockedEnvKey(" BASH_FUNC_x%%")).toBe(true);
    expect(isBlockedEnvKey("NPM_CONFIG_REGISTRY ")).toBe(true);
    expect(isBlockedEnvKey("  LD_PRELOAD  ")).toBe(true);
  });

  it("still accepts the exact-key denylist through the same predicate", () => {
    expect(isBlockedEnvKey("LD_PRELOAD")).toBe(true);
    expect(isBlockedEnvKey("ld_preload")).toBe(true);
    expect(isBlockedEnvKey("STEWARD_API_KEY")).toBe(true);
    expect(isBlockedEnvKey("SAFE_PUBLIC_FLAG")).toBe(false);
  });

  it("drops prefix-family keys during startup env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          "BASH_FUNC_x%%": "() { :; }; /tmp/evil",
          NPM_CONFIG_REGISTRY: "https://evil.example",
          SAFE_PUBLIC_FLAG: "enabled",
        },
        DOCKER_HOST: "tcp://evil.example:2375",
        UVICORN_HOST: "127.0.0.1",
        SAFE_DIRECT_VALUE: "direct",
      },
    });

    expect(envVars).toEqual({
      SAFE_PUBLIC_FLAG: "enabled",
      UVICORN_HOST: "127.0.0.1",
      SAFE_DIRECT_VALUE: "direct",
    });
  });

  it("blocks canonical secret keys during startup env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          OPINION_API_KEY: "opinion-api",
          STEWARD_API_KEY: "steward-api",
          SAFE_PUBLIC_FLAG: "enabled",
        },
        OPINION_PRIVATE_KEY: "opinion-private",
        STEWARD_AGENT_TOKEN: "steward-token",
        SAFE_DIRECT_VALUE: "direct",
      },
    });

    expect(envVars).toEqual({
      SAFE_PUBLIC_FLAG: "enabled",
      SAFE_DIRECT_VALUE: "direct",
    });
  });

  it("blocks new injection primitives during config env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          JDK_JAVA_OPTIONS: "-javaagent:/tmp/evil.jar",
          GIT_SSH: "/tmp/evil-ssh",
          GIT_CONFIG_KEY_0: "core.sshCommand",
          GIT_CONFIG_VALUE_0: "/tmp/evil-cmd",
          SAFE_FLAG: "true",
        },
      },
    });

    expect(envVars).toEqual({ SAFE_FLAG: "true" });
  });
});
