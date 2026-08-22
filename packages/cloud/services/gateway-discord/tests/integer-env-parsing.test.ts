/**
 * Covers the single lexical integer parser both gateway-discord env helpers
 * delegate to, plus the range policy each caller keeps for itself.
 *
 * `Number.parseInt` stops at the first non-digit, so "3600junk" previously
 * parsed to 3600 and became configuration nobody set.
 */
import { describe, expect, test } from "bun:test";
import { parseIntegerEnvValue } from "../src/integer-env";

const NAME = "VOICE_AUDIO_TTL_SECONDS";

describe("parseIntegerEnvValue", () => {
  test("returns undefined when the variable is unset so callers apply their default", () => {
    expect(parseIntegerEnvValue(NAME, undefined)).toBeUndefined();
  });

  test("rejects trailing garbage rather than parsing its prefix", () => {
    expect(() => parseIntegerEnvValue(NAME, "3600junk")).toThrow(
      "is not a valid integer",
    );
  });

  test("rejects a fractional value", () => {
    expect(() => parseIntegerEnvValue(NAME, "3600.5")).toThrow(
      "is not a valid integer",
    );
  });

  test("rejects an integer beyond the safe range", () => {
    expect(() => parseIntegerEnvValue(NAME, "9007199254740993")).toThrow(
      "is not a valid integer",
    );
  });

  test("accepts a clean integer, including a signed one", () => {
    // `Number.parseInt` accepted "+3600"; rejecting it would be a regression.
    expect(parseIntegerEnvValue(NAME, "3600")).toBe(3600);
    expect(parseIntegerEnvValue(NAME, "+3600")).toBe(3600);
    expect(parseIntegerEnvValue(NAME, " 3600 ")).toBe(3600);
  });

  test("leaves range policy to the caller by accepting a negative integer", () => {
    // The gateway manager's `minValue` check is the range authority, so the
    // lexical parser must not pre-empt it.
    expect(parseIntegerEnvValue(NAME, "-1")).toBe(-1);
  });
});

describe("gateway-discord env helpers over the shared parser", () => {
  const saved = new Map<string, string | undefined>();
  function stub(key: string, value: string): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  function restore(): void {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  }

  test("the voice handler refuses a prefix-parsed TTL at module load", async () => {
    stub("VOICE_AUDIO_TTL_SECONDS", "3600junk");
    try {
      await expect(
        import(`../src/voice-message-handler?case=vmh-${Date.now()}`),
      ).rejects.toThrow("is not a valid integer");
    } finally {
      restore();
    }
  });

  test("the gateway manager refuses a prefix-parsed value at module load", async () => {
    stub("MAX_BOTS_PER_POD", "5junk");
    try {
      await expect(
        import(`../src/gateway-manager?case=gm-${Date.now()}`),
      ).rejects.toThrow("is not a valid integer");
    } finally {
      restore();
    }
  });

  test("the gateway manager still enforces its own minimum", async () => {
    stub("MAX_BOTS_PER_POD", "0");
    try {
      await expect(
        import(`../src/gateway-manager?case=gm-min-${Date.now()}`),
      ).rejects.toThrow("below minimum value");
    } finally {
      restore();
    }
  });
});
