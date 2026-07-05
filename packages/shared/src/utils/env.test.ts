/**
 * Env value normalization + the boolean-disabled check. Empty/whitespace must
 * normalize to absent, and isEnvDisabled must treat only explicit falsy tokens
 * as "off" (default-enabled) — a loose check here would flip feature defaults.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config.js";
import {
  buildBrandEnvAliases,
  buildBrandEnvSyncAliases,
} from "../config/brand-env-aliases.js";
import {
  isAndroidMobile,
  resolveDesktopApiPort,
  resolvePlatform,
} from "../runtime-env.js";
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
    [`${BRAND}_ALLOWED_HOSTS`, "ELIZA_ALLOWED_HOSTS"],
    [`${BRAND}_DISABLE_AUTO_API_TOKEN`, "ELIZA_DISABLE_AUTO_API_TOKEN"],
    [`${BRAND}_ALLOW_WS_QUERY_TOKEN`, "ELIZA_ALLOW_WS_QUERY_TOKEN"],
    [`${BRAND}_PAIRING_DISABLED`, "ELIZA_PAIRING_DISABLED"],
    [`${BRAND}_WALLET_EXPORT_TOKEN`, "ELIZA_WALLET_EXPORT_TOKEN"],
    [`${BRAND}_TERMINAL_RUN_TOKEN`, "ELIZA_TERMINAL_RUN_TOKEN"],
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

  it("resolves previously-divergent security aliases from branded keys", () => {
    process.env[`${BRAND}_ALLOWED_HOSTS`] = "acme.example";
    process.env[`${BRAND}_DISABLE_AUTO_API_TOKEN`] = "1";
    process.env[`${BRAND}_ALLOW_WS_QUERY_TOKEN`] = "1";
    process.env[`${BRAND}_PAIRING_DISABLED`] = "1";
    process.env[`${BRAND}_WALLET_EXPORT_TOKEN`] = "wallet-token";
    process.env[`${BRAND}_TERMINAL_RUN_TOKEN`] = "terminal-token";

    expect(readAliasedEnv("ELIZA_ALLOWED_HOSTS")).toBe("acme.example");
    expect(readAliasedEnv("ELIZA_DISABLE_AUTO_API_TOKEN")).toBe("1");
    expect(readAliasedEnv("ELIZA_ALLOW_WS_QUERY_TOKEN")).toBe("1");
    expect(readAliasedEnv("ELIZA_PAIRING_DISABLED")).toBe("1");
    expect(readAliasedEnv("ELIZA_WALLET_EXPORT_TOKEN")).toBe("wallet-token");
    expect(readAliasedEnv("ELIZA_TERMINAL_RUN_TOKEN")).toBe("terminal-token");
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

  it("materializes every sync brand alias target from the shared table", () => {
    const aliases = buildBrandEnvSyncAliases("BRAND");
    const defaultedKeys = [
      "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
      "ELIZA_APP_ROUTE_PLUGIN_MODULES",
    ];
    const tracked = Array.from(new Set([...aliases.flat(), ...defaultedKeys]));
    const previous = new Map(
      tracked.map((key) => [key, process.env[key]] as const),
    );

    try {
      for (const [from, to] of aliases) {
        for (const key of tracked) {
          delete process.env[key];
        }
        process.env[from] = `${from}-value`;

        syncElizaEnvAliases({ brandedPrefix: "BRAND" });

        expect(process.env[to]).toBe(`${from}-value`);
      }
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

  it("keeps legacy BRAND_PORT sync pointed at the UI port", () => {
    const runtimeAliases = new Map(buildBrandEnvAliases("BRAND"));
    const syncAliases = new Map(buildBrandEnvSyncAliases("BRAND"));
    expect(runtimeAliases.get("BRAND_PORT")).toBe("ELIZA_PORT");
    expect(syncAliases.get("BRAND_PORT")).toBe("ELIZA_UI_PORT");

    const keys = ["BRAND_PORT", "ELIZA_PORT", "ELIZA_UI_PORT"];
    const previous = new Map(
      keys.map((key) => [key, process.env[key]] as const),
    );

    try {
      for (const key of keys) {
        delete process.env[key];
      }
      process.env.BRAND_PORT = "4100";

      syncElizaEnvAliases({ brandedPrefix: "BRAND" });

      expect(process.env.ELIZA_UI_PORT).toBe("4100");
      expect(process.env.ELIZA_PORT).toBeUndefined();
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

  it("prefers explicit BRAND_UI_PORT over the legacy BRAND_PORT sync fallback", () => {
    const keys = ["BRAND_PORT", "BRAND_UI_PORT", "ELIZA_PORT", "ELIZA_UI_PORT"];
    const previous = new Map(
      keys.map((key) => [key, process.env[key]] as const),
    );

    try {
      for (const key of keys) {
        delete process.env[key];
      }
      process.env.BRAND_PORT = "4100";
      process.env.BRAND_UI_PORT = "4101";

      syncElizaEnvAliases({ brandedPrefix: "BRAND" });

      expect(process.env.ELIZA_UI_PORT).toBe("4101");
      expect(process.env.ELIZA_PORT).toBeUndefined();
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

// Issue #13422 P4 boot-runtime slice: the agent-boot reads migrated to the
// alias-aware resolvers — state dir (bin.ts / trajectory-recorder), platform
// (bin.ts), API port (eliza.ts boot), cloud provisioning, managed-agents
// segment, and the orchestrator toggle (plugin-collector) — must resolve a
// branded (non-ELIZA) prefix WITHOUT the process.env alias-sync mirror, with the
// canonical ELIZA_ key still winning when both are set. A NON-ELIZA prefix is
// the security-relevant fixture: an ELIZA->ELIZA self-mirror proves nothing.
describe("issue #13422 P4 agent-boot keys resolve a branded prefix with zero mirror writes", () => {
  const BRAND = "MILADY";
  const savedConfig = getBootConfig();
  const aliases = buildBrandEnvAliases(BRAND);
  const tracked = [
    "MILADY_STATE_DIR",
    "ELIZA_STATE_DIR",
    "MILADY_PLATFORM",
    "ELIZA_PLATFORM",
    "MILADY_API_PORT",
    "ELIZA_API_PORT",
    "MILADY_PORT",
    "ELIZA_PORT",
    "MILADY_UI_PORT",
    "ELIZA_UI_PORT",
    "MILADY_CLOUD_PROVISIONED",
    "ELIZA_CLOUD_PROVISIONED",
    "MILADY_CLOUD_MANAGED_AGENTS_API_SEGMENT",
    "ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT",
    "MILADY_AGENT_ORCHESTRATOR",
    "ELIZA_AGENT_ORCHESTRATOR",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of tracked) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Pin the alias table on the immutable BootConfig, as the app boot path does.
    setBootConfig({ ...savedConfig, envAliases: aliases });
  });

  afterEach(() => {
    for (const key of tracked) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setBootConfig(savedConfig);
  });

  it("readAliasedEnv resolves the boot-critical agent keys from branded values, no mirror", () => {
    process.env.MILADY_STATE_DIR = "/var/milady/state";
    process.env.MILADY_CLOUD_PROVISIONED = "1";
    process.env.MILADY_CLOUD_MANAGED_AGENTS_API_SEGMENT = "milady";
    process.env.MILADY_AGENT_ORCHESTRATOR = "true";
    const before = { ...process.env };

    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/milady/state");
    expect(readAliasedEnv("ELIZA_CLOUD_PROVISIONED")).toBe("1");
    expect(readAliasedEnv("ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT")).toBe(
      "milady",
    );
    // plugin-collector lowercases this for its 0/false/no vs 1/true/yes gate.
    expect(readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase()).toBe(
      "true",
    );

    // A read must never materialize the ELIZA_ target — that mutation is exactly
    // what #13422 removes the dependency on.
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
    expect(process.env.ELIZA_CLOUD_PROVISIONED).toBeUndefined();
    expect(process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT).toBeUndefined();
    expect(process.env.ELIZA_AGENT_ORCHESTRATOR).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("canonical ELIZA_ key wins over the branded alias", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.MILADY_CLOUD_PROVISIONED = "0";
    expect(readAliasedEnv("ELIZA_CLOUD_PROVISIONED")).toBe("1");

    process.env.ELIZA_STATE_DIR = "/canonical";
    process.env.MILADY_STATE_DIR = "/branded";
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/canonical");
  });

  it("resolveDesktopApiPort (eliza.ts boot) honors a branded MILADY_API_PORT, no mirror", () => {
    process.env.MILADY_API_PORT = "31555";
    const before = { ...process.env };
    // The eliza.ts boot guard reads readAliasedEnv('ELIZA_API_PORT') then calls
    // resolveDesktopApiPort — both must see the branded port.
    expect(readAliasedEnv("ELIZA_API_PORT")).toBe("31555");
    expect(resolveDesktopApiPort()).toBe(31555);
    expect(process.env.ELIZA_API_PORT).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("canonical ELIZA_API_PORT wins over a branded MILADY_API_PORT", () => {
    process.env.ELIZA_API_PORT = "31337";
    process.env.MILADY_API_PORT = "40000";
    expect(readAliasedEnv("ELIZA_API_PORT")).toBe("31337");
    expect(resolveDesktopApiPort()).toBe(31337);
  });

  it("isAndroidMobile / resolvePlatform (bin.ts) honor a branded MILADY_PLATFORM, no mirror", () => {
    process.env.MILADY_PLATFORM = "android";
    const before = { ...process.env };
    expect(resolvePlatform()).toBe("android");
    expect(isAndroidMobile()).toBe(true);
    expect(process.env.ELIZA_PLATFORM).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("canonical ELIZA_PLATFORM wins over a branded MILADY_PLATFORM", () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.MILADY_PLATFORM = "android";
    expect(resolvePlatform()).toBe("ios");
    expect(isAndroidMobile()).toBe(false);
  });
});
