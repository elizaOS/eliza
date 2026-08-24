/**
 * Pins preset resolution. The registry is a plain object looked up with a name
 * that reaches it from an environment variable, so lookup must resolve only
 * registry-owned keys: inherited Object.prototype members must never be
 * returned as a preset. Also covers the merge contract, where text fields
 * concatenate but scalar fields override. Env is saved and restored per test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getPresetFromEnv,
  getPromptPreset,
  mergePromptConfig,
  type PromptPresetName,
  promptPresets,
} from "./prompt-presets";

const ENV_KEY = "APP_PROMPT_PRESET";
const NAMES = Object.keys(promptPresets) as PromptPresetName[];

/** Keys every plain object inherits but the registry never declares. */
const INHERITED = [
  "toString",
  "valueOf",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
] as const;

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

function isPreset(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("promptPresets registry", () => {
  test("declares at least one preset, each an object", () => {
    expect(NAMES.length).toBeGreaterThan(0);
    for (const name of NAMES) expect(isPreset(promptPresets[name])).toBe(true);
  });

  test("owns exactly the declared names", () => {
    for (const name of NAMES) {
      expect(Object.hasOwn(promptPresets, name)).toBe(true);
    }
    for (const key of INHERITED) {
      expect(Object.hasOwn(promptPresets, key)).toBe(false);
    }
  });
});

describe("getPromptPreset", () => {
  test("returns the declared preset for each name", () => {
    for (const name of NAMES) {
      expect(getPromptPreset(name)).toBe(promptPresets[name]);
    }
  });

  test("throws for an unknown name", () => {
    expect(() => getPromptPreset("nope" as PromptPresetName)).toThrow();
  });

  test.each(INHERITED)("throws for inherited key %s", (key) => {
    expect(() => getPromptPreset(key as PromptPresetName)).toThrow();
  });

  test("never returns a non-object", () => {
    for (const key of [...NAMES, ...INHERITED]) {
      let result: unknown;
      try {
        result = getPromptPreset(key as PromptPresetName);
      } catch {
        continue;
      }
      expect(isPreset(result)).toBe(true);
    }
  });
});

describe("getPresetFromEnv", () => {
  test("returns null when unset or blank", () => {
    expect(getPresetFromEnv()).toBeNull();
    process.env[ENV_KEY] = "";
    expect(getPresetFromEnv()).toBeNull();
  });

  test("returns the named preset", () => {
    for (const name of NAMES) {
      process.env[ENV_KEY] = name;
      expect(getPresetFromEnv()).toBe(promptPresets[name]);
    }
  });

  test("returns null for an unknown name", () => {
    process.env[ENV_KEY] = "not-a-preset";
    expect(getPresetFromEnv()).toBeNull();
  });

  test.each(INHERITED)("returns null for inherited key %s", (key) => {
    process.env[ENV_KEY] = key;
    expect(getPresetFromEnv()).toBeNull();
  });

  test("never returns a non-object", () => {
    for (const value of [...NAMES, ...INHERITED, "junk", ""]) {
      process.env[ENV_KEY] = value;
      const result = getPresetFromEnv();
      if (result === null) continue;
      expect(isPreset(result)).toBe(true);
    }
  });
});

describe("mergePromptConfig", () => {
  test("returns the base defaults with no inputs", () => {
    expect(mergePromptConfig()).toEqual({
      systemPrefix: "",
      systemSuffix: "",
      responseStyle: "",
      flirtiness: "low",
      romanticMode: false,
    });
  });

  test("concatenates text fields preset-first, newline separated", () => {
    const merged = mergePromptConfig(
      { systemPrefix: "cfg", systemSuffix: "cfgS", responseStyle: "cfgR" },
      { systemPrefix: "pre", systemSuffix: "preS", responseStyle: "preR" } as never,
    );
    expect(merged.systemPrefix).toBe("pre\ncfg");
    expect(merged.systemSuffix).toBe("preS\ncfgS");
    expect(merged.responseStyle).toBe("preR\ncfgR");
  });

  test("omits a missing side rather than leaving a blank line", () => {
    expect(mergePromptConfig({ systemPrefix: "only" }).systemPrefix).toBe("only");
    expect(mergePromptConfig(undefined, { systemPrefix: "only" } as never).systemPrefix).toBe(
      "only",
    );
    expect(mergePromptConfig().systemPrefix).toBe("");
  });

  test("config overrides preset for scalar fields", () => {
    const merged = mergePromptConfig({ flirtiness: "high", romanticMode: true }, {
      flirtiness: "low",
      romanticMode: false,
    } as never);
    expect(merged.flirtiness).toBe("high");
    expect(merged.romanticMode).toBe(true);
  });

  test("preset supplies scalars the config omits", () => {
    expect(mergePromptConfig({}, { flirtiness: "medium" } as never).flirtiness).toBe("medium");
  });

  test("tolerates a null preset", () => {
    expect(mergePromptConfig({ flirtiness: "high" }, null).flirtiness).toBe("high");
  });

  test("does not mutate its inputs", () => {
    const config = { systemPrefix: "cfg" };
    const preset = { systemPrefix: "pre" } as never;
    const snapshots = [{ ...config }, { ...(preset as object) }];
    mergePromptConfig(config, preset);
    expect([{ ...config }, { ...(preset as object) }]).toEqual(snapshots);
  });

  test("merges every declared preset without throwing", () => {
    for (const name of NAMES) {
      expect(() => mergePromptConfig({}, promptPresets[name])).not.toThrow();
    }
  });
});
