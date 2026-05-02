/**
 * Tests for the spawn-env allowlist enforced by buildSanitizedBaseEnv.
 *
 * The allowlist is a security boundary: by default, every var in
 * process.env is stripped before a sub-agent inherits the env, so a
 * leaked secret on the host process never crosses into a coding agent
 * shell. A handful of names are exceptions because they're either
 * required for the shell to work (PATH, HOME, USER, …) or they're
 * explicit user grants the parent runtime sets on the user's behalf
 * (ANTHROPIC_MODEL, GITHUB_TOKEN).
 *
 * Covers:
 * - PATH and other system vars survive
 * - GITHUB_TOKEN survives when set (required for the GitHub connection
 *   card flow in the host runtime)
 * - GITHUB_TOKEN is absent from the result when unset on the parent
 * - random secret-looking vars are stripped
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSanitizedBaseEnv } from "../services/pty-spawn.js";

const SAVED: Record<string, string | undefined> = {};
const TOUCHED_KEYS = [
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MILADY_TEST_SECRET",
];

beforeEach(() => {
  for (const key of TOUCHED_KEYS) {
    SAVED[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (SAVED[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = SAVED[key];
    }
  }
});

describe("buildSanitizedBaseEnv", () => {
  it("keeps system vars (PATH at minimum)", () => {
    const env = buildSanitizedBaseEnv();
    expect(env.PATH).toBeDefined();
    expect(env.PATH?.length ?? 0).toBeGreaterThan(0);
  });

  it("forwards GITHUB_TOKEN when set on the parent", () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_for_allowlist";
    const env = buildSanitizedBaseEnv();
    expect(env.GITHUB_TOKEN).toBe("ghp_test_token_for_allowlist");
  });

  it("omits GITHUB_TOKEN when not set on the parent", () => {
    const env = buildSanitizedBaseEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("strips secret-looking vars that are not on the allowlist", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.MILADY_TEST_SECRET = "should-not-leak";
    const env = buildSanitizedBaseEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MILADY_TEST_SECRET).toBeUndefined();
  });
});
