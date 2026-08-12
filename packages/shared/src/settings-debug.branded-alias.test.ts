/**
 * Shared settings-debug must honor boot-config brand↔ELIZA aliases the same
 * way `@elizaos/core` does (#18056 review: no regression for white-label).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isElizaSettingsDebugEnabled } from "./settings-debug.ts";

const STORE_KEY = Symbol.for("elizaos.app.boot-config");
const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
type Slot = Record<PropertyKey, unknown>;

const MILADY_ALIASES = [
  ["MILADY_SETTINGS_DEBUG", "ELIZA_SETTINGS_DEBUG"],
  ["VITE_MILADY_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
] as const;

describe("shared isElizaSettingsDebugEnabled branded aliases", () => {
  const tracked = [
    "MILADY_SETTINGS_DEBUG",
    "ELIZA_SETTINGS_DEBUG",
    "VITE_MILADY_SETTINGS_DEBUG",
    "VITE_ELIZA_SETTINGS_DEBUG",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let savedStore: unknown;
  let savedWindow: unknown;

  beforeEach(() => {
    const slot = globalThis as Slot;
    savedStore = slot[STORE_KEY];
    savedWindow = slot[WINDOW_KEY];
    for (const key of tracked) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    slot[STORE_KEY] = { current: { envAliases: MILADY_ALIASES } };
  });

  afterEach(() => {
    const slot = globalThis as Slot;
    if (savedStore === undefined) delete slot[STORE_KEY];
    else slot[STORE_KEY] = savedStore;
    if (savedWindow === undefined) delete slot[WINDOW_KEY];
    else slot[WINDOW_KEY] = savedWindow;
    for (const key of tracked) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("honors MILADY_SETTINGS_DEBUG without mirroring ELIZA_SETTINGS_DEBUG", () => {
    process.env.MILADY_SETTINGS_DEBUG = "1";
    const before = { ...process.env };
    expect(isElizaSettingsDebugEnabled()).toBe(true);
    expect(process.env.ELIZA_SETTINGS_DEBUG).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it("honors VITE_MILADY_SETTINGS_DEBUG", () => {
    process.env.VITE_MILADY_SETTINGS_DEBUG = "true";
    expect(isElizaSettingsDebugEnabled()).toBe(true);
    expect(process.env.VITE_ELIZA_SETTINGS_DEBUG).toBeUndefined();
  });

  it("stays false when no flag is set", () => {
    expect(isElizaSettingsDebugEnabled()).toBe(false);
  });
});
