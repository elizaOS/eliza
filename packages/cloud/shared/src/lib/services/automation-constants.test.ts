/**
 * Exercises automation configuration merging, including object freshness,
 * caller overrides, and explicit undefined values. Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  DISCORD_AUTOMATION_DEFAULTS,
  getDiscordConfigWithDefaults,
  getTelegramConfigWithDefaults,
  getTwitterConfigWithDefaults,
  TELEGRAM_AUTOMATION_DEFAULTS,
  TWITTER_AUTOMATION_DEFAULTS,
} from "./automation-constants";

describe("config merge helpers", () => {
  const helpers = [
    ["discord", getDiscordConfigWithDefaults, DISCORD_AUTOMATION_DEFAULTS],
    ["telegram", getTelegramConfigWithDefaults, TELEGRAM_AUTOMATION_DEFAULTS],
    ["twitter", getTwitterConfigWithDefaults, TWITTER_AUTOMATION_DEFAULTS],
  ] as const;

  test.each(helpers)("%s returns the defaults for null", (_name, helper, defaults) => {
    expect(helper(null)).toEqual({ ...defaults });
  });

  test.each(helpers)(
    "%s returns the defaults for undefined and for an empty object",
    (_name, helper, defaults) => {
      expect(helper(undefined)).toEqual({ ...defaults });
      expect(helper({})).toEqual({ ...defaults });
    },
  );

  test.each(helpers)("%s lets a supplied value win", (_name, helper) => {
    expect(helper({ enabled: true }).enabled).toBe(true);
  });

  test.each(helpers)("%s keeps unrelated defaults intact", (_name, helper, defaults) => {
    const merged = helper({ enabled: true }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(defaults)) {
      if (key === "enabled") continue;
      expect(merged[key]).toBe(value);
    }
  });

  test.each(helpers)("%s passes through unknown keys", (_name, helper) => {
    expect((helper({ future: "x" }) as Record<string, unknown>).future).toBe("x");
  });

  test.each(helpers)("%s does not mutate the shared defaults", (_name, helper, defaults) => {
    const snapshot = { ...defaults };
    helper({ enabled: true });
    expect({ ...defaults }).toEqual(snapshot);
  });

  test.each(helpers)("%s returns a fresh object each call", (_name, helper) => {
    expect(helper({})).not.toBe(helper({}));
  });

  // Documents the spread edge rather than endorsing it: a key that is PRESENT
  // with an explicit `undefined` overwrites the default instead of falling back
  // to it. Callers currently re-defend downstream (see the `|| DEFAULTS.x`
  // pattern in discord-automation/app-automation.ts), so this is a trap for a
  // future caller rather than a live defect.
  test.each(helpers)(
    "%s: an explicit undefined overwrites the default (spread semantics)",
    (_name, helper) => {
      const merged = helper({ enabled: undefined }) as Record<string, unknown>;
      expect("enabled" in merged).toBe(true);
      expect(merged.enabled).toBeUndefined();
    },
  );
});
