/**
 * Proves the bin.ts boot debug-log env reads migrated to `readAliasedEnv`
 * (#13422 P1 long-tail) resolve a NON-ELIZA brand prefix (MILADY_*) through the
 * boot-config alias table WITHOUT the `syncBrandEnvToEliza` mirror mutation, that
 * a present canonical `ELIZA_*` value wins over the branded alias, and that an
 * empty value reads as unset. bin.ts itself is not import-testable (its module
 * eval configures mobile DNS and pins bootstrap symbols onto globalThis), so this
 * drives the exact `readAliasedEnv("ELIZA_PLATFORM")` / `readAliasedEnv("ELIZA_STATE_DIR")`
 * primitive calls the migrated line makes — the same pattern the P3 suite uses for
 * its non-importable server.ts/tui port reads.
 */
import {
  buildBrandEnvAliases,
  getBootConfig,
  readAliasedEnv,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MILADY_ALIASES = buildBrandEnvAliases("MILADY");

const TOUCHED_ENV_KEYS = [
  "MILADY_PLATFORM",
  "ELIZA_PLATFORM",
  "MILADY_STATE_DIR",
  "ELIZA_STATE_DIR",
] as const;

describe("#13422 P1 — alias-aware bin.ts boot debug-log env reads", () => {
  const savedConfig = getBootConfig();
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    setBootConfig({ ...savedConfig, envAliases: MILADY_ALIASES });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  describe("ELIZA_PLATFORM", () => {
    it("resolves from the branded MILADY_PLATFORM without writing the ELIZA mirror", () => {
      process.env.MILADY_PLATFORM = "android";
      expect(readAliasedEnv("ELIZA_PLATFORM")).toBe("android");
      expect(process.env.ELIZA_PLATFORM).toBeUndefined();
    });

    it("lets a present canonical ELIZA_PLATFORM win over the branded alias", () => {
      process.env.ELIZA_PLATFORM = "ios";
      process.env.MILADY_PLATFORM = "android";
      expect(readAliasedEnv("ELIZA_PLATFORM")).toBe("ios");
    });

    it("reads an empty branded value as unset", () => {
      process.env.MILADY_PLATFORM = "   ";
      expect(readAliasedEnv("ELIZA_PLATFORM")).toBeUndefined();
    });
  });

  describe("ELIZA_STATE_DIR", () => {
    it("resolves from the branded MILADY_STATE_DIR without writing the ELIZA mirror", () => {
      process.env.MILADY_STATE_DIR = "/data/milady/state";
      expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/data/milady/state");
      expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
    });

    it("lets a present canonical ELIZA_STATE_DIR win over the branded alias", () => {
      process.env.ELIZA_STATE_DIR = "/canonical/state";
      process.env.MILADY_STATE_DIR = "/data/milady/state";
      expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/canonical/state");
    });

    it("reads an empty canonical value as unset (falls through to no value)", () => {
      process.env.ELIZA_STATE_DIR = "";
      expect(readAliasedEnv("ELIZA_STATE_DIR")).toBeUndefined();
    });
  });
});
