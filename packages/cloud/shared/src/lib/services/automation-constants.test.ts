/**
 * Pins the shared automation interval bounds and the defaults helpers. The
 * bounds are a ladder (MIN_ALLOWED <= DEFAULT_MIN <= DEFAULT_MAX <=
 * MAX_ALLOWED) that nothing enforces, and the helpers merge by object spread —
 * which has a sharp edge worth documenting: a key present with an explicit
 * `undefined` overwrites the default rather than falling back to it. Pure
 * module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_INTERVALS,
  DISCORD_AUTOMATION_DEFAULTS,
  getDiscordConfigWithDefaults,
  getTelegramConfigWithDefaults,
  getTwitterConfigWithDefaults,
  TELEGRAM_AUTOMATION_DEFAULTS,
  TWITTER_AUTOMATION_DEFAULTS,
} from "./automation-constants";

describe("AUTOMATION_INTERVALS", () => {
  test("forms a consistent bounds ladder", () => {
    expect(AUTOMATION_INTERVALS.MIN_ALLOWED).toBeLessThanOrEqual(AUTOMATION_INTERVALS.DEFAULT_MIN);
    expect(AUTOMATION_INTERVALS.DEFAULT_MIN).toBeLessThanOrEqual(AUTOMATION_INTERVALS.DEFAULT_MAX);
    expect(AUTOMATION_INTERVALS.DEFAULT_MAX).toBeLessThanOrEqual(AUTOMATION_INTERVALS.MAX_ALLOWED);
  });

  test("every bound is a positive whole number of minutes", () => {
    for (const value of Object.values(AUTOMATION_INTERVALS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  test("the allowed window is wider than the default window", () => {
    expect(AUTOMATION_INTERVALS.MIN_ALLOWED).toBeLessThan(AUTOMATION_INTERVALS.MAX_ALLOWED);
    expect(
      AUTOMATION_INTERVALS.MAX_ALLOWED - AUTOMATION_INTERVALS.MIN_ALLOWED,
    ).toBeGreaterThanOrEqual(AUTOMATION_INTERVALS.DEFAULT_MAX - AUTOMATION_INTERVALS.DEFAULT_MIN);
  });
});

describe("per-service defaults", () => {
  const suites = [
    ["discord", DISCORD_AUTOMATION_DEFAULTS, "announceInterval"],
    ["telegram", TELEGRAM_AUTOMATION_DEFAULTS, "announceInterval"],
    ["twitter", TWITTER_AUTOMATION_DEFAULTS, "postInterval"],
  ] as const;

  test.each(suites)("%s ships disabled", (_name, defaults) => {
    expect(defaults.enabled).toBe(false);
  });

  test.each(suites)(
    "%s interval defaults come from the shared table",
    (_name, defaults, prefix) => {
      const record = defaults as unknown as Record<string, number>;
      expect(record[`${prefix}Min`]).toBe(AUTOMATION_INTERVALS.DEFAULT_MIN);
      expect(record[`${prefix}Max`]).toBe(AUTOMATION_INTERVALS.DEFAULT_MAX);
    },
  );

  test.each(suites)("%s min interval never exceeds its max", (_name, defaults, prefix) => {
    const record = defaults as unknown as Record<string, number>;
    expect(record[`${prefix}Min`]).toBeLessThanOrEqual(record[`${prefix}Max`]);
  });

  test.each(suites)("%s intervals sit inside the allowed window", (_name, defaults, prefix) => {
    const record = defaults as unknown as Record<string, number>;
    for (const key of [`${prefix}Min`, `${prefix}Max`]) {
      expect(record[key]).toBeGreaterThanOrEqual(AUTOMATION_INTERVALS.MIN_ALLOWED);
      expect(record[key]).toBeLessThanOrEqual(AUTOMATION_INTERVALS.MAX_ALLOWED);
    }
  });

  test("no automation ships with an outbound behaviour pre-enabled", () => {
    expect(DISCORD_AUTOMATION_DEFAULTS.autoAnnounce).toBe(false);
    expect(TELEGRAM_AUTOMATION_DEFAULTS.autoAnnounce).toBe(false);
    expect(TWITTER_AUTOMATION_DEFAULTS.autoPost).toBe(false);
    expect(TWITTER_AUTOMATION_DEFAULTS.autoReply).toBe(false);
    expect(TWITTER_AUTOMATION_DEFAULTS.autoEngage).toBe(false);
    expect(TWITTER_AUTOMATION_DEFAULTS.discovery).toBe(false);
  });
});

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
