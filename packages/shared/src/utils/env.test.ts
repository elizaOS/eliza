/**
 * Env value normalization + the boolean-disabled check. Empty/whitespace must
 * normalize to absent, and isEnvDisabled must treat only explicit falsy tokens
 * as "off" (default-enabled) — a loose check here would flip feature defaults.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_ROUTE_PLUGIN_MODULES,
  isEnvDisabled,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
  syncElizaEnvAliases,
} from "./env";

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
      "BRAND_STATE_DIR",
      "BRAND_USE_PI_AI",
      "BRAND_TASK_AGENT_AUTH_TRUSTED_HOSTS",
      "BRAND_TASK_AGENT_AUTH_API_BASE_URL",
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
      process.env.BRAND_STATE_DIR = "/tmp/brand-state";
      process.env.BRAND_USE_PI_AI = "1";
      process.env.BRAND_TASK_AGENT_AUTH_TRUSTED_HOSTS = "localhost";
      process.env.BRAND_TASK_AGENT_AUTH_API_BASE_URL = "http://localhost:3000";

      syncElizaEnvAliases({ brandedPrefix: "BRAND" });

      expect(process.env.ELIZA_STATE_DIR).toBe("/tmp/brand-state");
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

  it("uses the shared default app route plugin modules", () => {
    const keys = [
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

      syncElizaEnvAliases({ brandedPrefix: "BRAND" });

      expect(process.env.ELIZA_APP_ROUTE_PLUGIN_MODULES).toBe(
        DEFAULT_APP_ROUTE_PLUGIN_MODULES.join(","),
      );
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
