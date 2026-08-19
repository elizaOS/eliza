/**
 * Pins the bounded AI SDK retry budget used by the Shared AgentRuntime model
 * adapter so interactive turns never inherit multi-second SDK backoff.
 */

import { describe, expect, test } from "bun:test";
import { resolveSharedTurnMaxRetries, SHARED_TURN_MAX_RETRIES } from "./shared-turn-retry-budget";

describe("shared AgentRuntime turn retry budget", () => {
  test("uses the bounded environment-derived budget", () => {
    expect(SHARED_TURN_MAX_RETRIES).toBe(
      resolveSharedTurnMaxRetries(process.env.SHARED_TURN_MAX_RETRIES),
    );
    expect(SHARED_TURN_MAX_RETRIES).toBeGreaterThanOrEqual(0);
    expect(SHARED_TURN_MAX_RETRIES).toBeLessThanOrEqual(2);
  });

  test.each([
    [undefined, 0],
    ["", 0],
    ["   ", 0],
    ["0", 0],
    ["1", 1],
    ["2", 2],
    ["5", 2],
    ["-1", 0],
    ["abc", 0],
  ])("SHARED_TURN_MAX_RETRIES=%p resolves to %p", (raw, expected) => {
    expect(resolveSharedTurnMaxRetries(raw)).toBe(expected);
  });
});
