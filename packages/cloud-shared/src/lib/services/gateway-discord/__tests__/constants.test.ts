/**
 * Discord Gateway Constants Unit Tests
 *
 * Tests for lib/services/gateway-discord/constants.ts
 */

import { describe, expect, test } from "bun:test";
import { DEAD_POD_THRESHOLD_MS } from "../constants";

describe("DEAD_POD_THRESHOLD_MS", () => {
  test("has correct default value of 45 seconds", () => {
    expect(DEAD_POD_THRESHOLD_MS).toBe(45_000);
  });

  test("is a positive number", () => {
    expect(DEAD_POD_THRESHOLD_MS).toBeGreaterThan(0);
  });

  test("is at least 3x typical heartbeat interval (15s)", () => {
    const HEARTBEAT_INTERVAL_MS = 15_000;
    expect(DEAD_POD_THRESHOLD_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 3);
  });

  test("is less than pod state TTL (300s / 5 minutes)", () => {
    const POD_STATE_TTL_MS = 300_000;
    expect(DEAD_POD_THRESHOLD_MS).toBeLessThan(POD_STATE_TTL_MS);
  });
});
