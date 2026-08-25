/**
 * Unit tests for handoff-pending token registry: validates generation minting,
 * in-flight checks, and token-matched settlement.
 */
import { describe, expect, it } from "vitest";
import {
  beginPendingHandoff,
  isPendingHandoffCurrent,
  settlePendingHandoff,
} from "./handoff-pending.ts";

describe("handoff-pending", () => {
  it("mints unique token and validates current in-flight state", () => {
    const sessionId = "session-test-1";
    const token = beginPendingHandoff(sessionId);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    expect(isPendingHandoffCurrent(sessionId, token)).toBe(true);
    expect(isPendingHandoffCurrent(sessionId, "stale-token-123")).toBe(false);
  });

  it("settles pending handoff cleanly when token matches", () => {
    const sessionId = "session-test-2";
    const token = beginPendingHandoff(sessionId);

    settlePendingHandoff(sessionId, "wrong-token");
    expect(isPendingHandoffCurrent(sessionId, token)).toBe(true);

    settlePendingHandoff(sessionId, token);
    expect(isPendingHandoffCurrent(sessionId, token)).toBe(false);
  });
});
