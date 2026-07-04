/**
 * Env value normalization + the boolean-disabled check. Empty/whitespace must
 * normalize to absent, and isEnvDisabled must treat only explicit falsy tokens
 * as "off" (default-enabled) — a loose check here would flip feature defaults.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config.js";
import {
  DEFAULT_APP_ROUTE_PLUGIN_MODULES,
  isEnvDisabled,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
  readAliasedEnv,
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

// #12251 slice 1: readAliasedEnv resolves brand<->eliza aliases from the
// immutable BootConfig WITHOUT mutating process.env. This fixture uses a
// NON-ELIZA brand prefix (an in-repo ELIZA->ELIZA self-mirror is not sufficient
// proof per the issue) and asserts the security-/boot-critical settings the
// original issue names — state dir, API token, ports, CORS — resolve correctly
// with ZERO runtime alias writes to process.env.
describe("readAliasedEnv (non-ELIZA brand, zero-mutation resolution)", () => {
  const BRAND = "ACME";
  const savedConfig = getBootConfig();
  // The security-/boot-critical settings the issue calls out, plus their
  // branded aliases, tracked so each case starts from a clean slate.
  const pairs: Array<readonly [string, string]> = [
    [`${BRAND}_STATE_DIR`, "ELIZA_STATE_DIR"],
    [`${BRAND}_API_TOKEN`, "ELIZA_API_TOKEN"],
    [`${BRAND}_API_PORT`, "ELIZA_API_PORT"],
    [`${BRAND}_HOME_PORT`, "ELIZA_HOME_PORT"],
    [`${BRAND}_GATEWAY_PORT`, "ELIZA_GATEWAY_PORT"],
    [`${BRAND}_ALLOWED_ORIGINS`, "ELIZA_ALLOWED_ORIGINS"],
  ];
  const tracked = pairs.flat();
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of tracked) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Pin the alias table on the immutable BootConfig, as the app boot path does.
    setBootConfig({ ...savedConfig, envAliases: pairs });
  });

  afterEach(() => {
    for (const key of tracked) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setBootConfig(savedConfig);
  });

  it("resolves state dir, API token, ports, and CORS from branded keys", () => {
    process.env[`${BRAND}_STATE_DIR`] = "/var/acme/state";
    process.env[`${BRAND}_API_TOKEN`] = "acme-secret-token";
    process.env[`${BRAND}_API_PORT`] = "7777";
    process.env[`${BRAND}_HOME_PORT`] = "7778";
    process.env[`${BRAND}_GATEWAY_PORT`] = "7779";
    process.env[`${BRAND}_ALLOWED_ORIGINS`] = "https://acme.example";

    // A read site asking for the ELIZA_ canonical name resolves the branded
    // value — no sync mutation required.
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/acme/state");
    expect(readAliasedEnv("ELIZA_API_TOKEN")).toBe("acme-secret-token");
    expect(readAliasedEnv("ELIZA_API_PORT")).toBe("7777");
    expect(readAliasedEnv("ELIZA_HOME_PORT")).toBe("7778");
    expect(readAliasedEnv("ELIZA_GATEWAY_PORT")).toBe("7779");
    expect(readAliasedEnv("ELIZA_ALLOWED_ORIGINS")).toBe(
      "https://acme.example",
    );
  });

  it("performs zero alias writes to process.env while resolving", () => {
    process.env[`${BRAND}_STATE_DIR`] = "/var/acme/state";
    process.env[`${BRAND}_API_TOKEN`] = "acme-secret-token";
    const before = { ...process.env };

    readAliasedEnv("ELIZA_STATE_DIR");
    readAliasedEnv("ELIZA_API_TOKEN");
    readAliasedEnv("ELIZA_API_PORT");

    // The ELIZA_ targets must never be materialized by a read — that is exactly
    // the process.env mutation #12251 exists to remove.
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("trims and drops empty branded values (normalizeEnvValue contract)", () => {
    process.env[`${BRAND}_STATE_DIR`] = "  /var/acme/state  ";
    process.env[`${BRAND}_API_TOKEN`] = "   ";
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/acme/state");
    expect(readAliasedEnv("ELIZA_API_TOKEN")).toBeUndefined();
  });

  it("prefers an explicit ELIZA_ value over the branded alias", () => {
    process.env.ELIZA_API_TOKEN = "canonical";
    process.env[`${BRAND}_API_TOKEN`] = "branded";
    expect(readAliasedEnv("ELIZA_API_TOKEN")).toBe("canonical");
  });

  it("a blank ELIZA_ value does not mask a present branded alias", () => {
    // Regression: an empty canonical API token must not resolve as missing when
    // a real branded token is set — that would fail security-critical auth on a
    // non-ELIZA brand deployment.
    process.env.ELIZA_API_TOKEN = "";
    process.env[`${BRAND}_API_TOKEN`] = "real-token";
    expect(readAliasedEnv("ELIZA_API_TOKEN")).toBe("real-token");
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
