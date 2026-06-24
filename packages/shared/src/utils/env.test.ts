import { describe, expect, it } from "vitest";
import {
  isEnvDisabled,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
  syncElizaEnvAliases,
} from "./env";

/**
 * Env value normalization + the boolean-disabled check. Empty/whitespace must
 * normalize to absent, and isEnvDisabled must treat only explicit falsy tokens
 * as "off" (default-enabled) — a loose check here would flip feature defaults.
 */

describe("normalizeEnvValue / normalizeEnvValueOrNull", () => {
  it("trims, maps empty/non-string to absent", () => {
    expect(normalizeEnvValue("  hi ")).toBe("hi");
    expect(normalizeEnvValue("   ")).toBeUndefined();
    expect(normalizeEnvValue(42)).toBeUndefined();
    expect(normalizeEnvValueOrNull("  hi ")).toBe("hi");
    expect(normalizeEnvValueOrNull("")).toBeNull();
  });
});

describe("isEnvDisabled", () => {
  it("treats only explicit falsy tokens as disabled", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
      expect(isEnvDisabled(v)).toBe(true);
    }
    for (const v of ["1", "true", "on", "yes", "", undefined]) {
      expect(isEnvDisabled(v)).toBe(false);
    }
  });
});

describe("syncElizaEnvAliases", () => {
  it("does not materialize removed branded aliases into ELIZA env vars", () => {
    const keys = [
      "MILADY_STATE_DIR",
      "MILADY_USE_PI_AI",
      "MILADY_TASK_AGENT_AUTH_TRUSTED_HOSTS",
      "MILADY_TASK_AGENT_AUTH_API_BASE_URL",
      "ELIZA_STATE_DIR",
      "ELIZA_USE_PI_AI",
      "ELIZA_TASK_AGENT_AUTH_TRUSTED_HOSTS",
      "ELIZA_TASK_AGENT_AUTH_API_BASE_URL",
      "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
      "ELIZA_APP_ROUTE_PLUGIN_MODULES",
    ];
    const previous = new Map(
      keys.map((key) => [key, process.env[key]] as const),
    );
    try {
      for (const key of keys) {
        delete process.env[key];
      }
      process.env.MILADY_STATE_DIR = "/tmp/milady-state";
      process.env.MILADY_USE_PI_AI = "1";
      process.env.MILADY_TASK_AGENT_AUTH_TRUSTED_HOSTS = "localhost";
      process.env.MILADY_TASK_AGENT_AUTH_API_BASE_URL = "http://localhost:3000";

      syncElizaEnvAliases({ brandedPrefix: "MILADY" });

      expect(process.env.ELIZA_STATE_DIR).toBe("/tmp/milady-state");
      expect(process.env.ELIZA_USE_PI_AI).toBeUndefined();
      expect(process.env.ELIZA_TASK_AGENT_AUTH_TRUSTED_HOSTS).toBeUndefined();
      expect(process.env.ELIZA_TASK_AGENT_AUTH_API_BASE_URL).toBeUndefined();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
