/**
 * Verifies PR #7747's `warnMissingUpstash` continues to fire under the
 * conditions that matter — and explicitly that `MOCK_REDIS=1` (a test-time
 * opt-in inside individual services) does NOT silence the orchestrator-host
 * warning when real Upstash creds are absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { warnMissingUpstash } from "../bootstrap-warn-missing-upstash.mjs";

const PREV_MOCK = process.env.MOCK_REDIS;

beforeEach(() => {
  delete process.env.MOCK_REDIS;
});

afterEach(() => {
  if (PREV_MOCK === undefined) delete process.env.MOCK_REDIS;
  else process.env.MOCK_REDIS = PREV_MOCK;
});

function capture(env: Record<string, string | undefined>): {
  fired: boolean;
  output: string;
} {
  let output = "";
  const fired = warnMissingUpstash(env, (s: string) => {
    output += s;
  });
  return { fired, output };
}

describe("warnMissingUpstash", () => {
  test("no Upstash creds, no MOCK_REDIS → warning fires", () => {
    const { fired, output } = capture({});
    expect(fired).toBe(true);
    expect(output).toContain("[bootstrap-provisioning-worker-host] WARNING:");
    expect(output).toContain("KV_REST_API_URL + KV_REST_API_TOKEN");
  });

  test("no Upstash creds AND MOCK_REDIS=1 → warning still fires (opt-in is not a substitute)", () => {
    process.env.MOCK_REDIS = "1";
    const { fired, output } = capture({});
    expect(fired).toBe(true);
    expect(output).toContain("WARNING");
  });

  test("only KV_REST_API_URL set, KV_REST_API_TOKEN missing → warning fires for the missing token", () => {
    const { fired, output } = capture({
      KV_REST_API_URL: "https://example.upstash.io",
    });
    expect(fired).toBe(true);
    expect(output).toContain("KV_REST_API_TOKEN");
    expect(output).not.toContain("KV_REST_API_URL + KV_REST_API_TOKEN");
  });

  test("both Upstash creds set → no warning, returns false", () => {
    const { fired, output } = capture({
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "real-token",
    });
    expect(fired).toBe(false);
    expect(output).toBe("");
  });

  test("whitespace-only creds count as missing", () => {
    const { fired, output } = capture({
      KV_REST_API_URL: "   ",
      KV_REST_API_TOKEN: "",
    });
    expect(fired).toBe(true);
    expect(output).toContain("KV_REST_API_URL + KV_REST_API_TOKEN");
  });
});
