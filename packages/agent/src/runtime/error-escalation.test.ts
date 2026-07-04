/**
 * Tests for the repeat-failure → owner-escalation wiring: the sliding-window
 * tracker's threshold + reset (no per-error spam), the ERROR_REPORTED handler
 * that fires exactly one escalation per burst, and the real
 * EscalationService.startEscalation coalescing an already-active escalation.
 */

import type { ErrorReportedPayload, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscalationService } from "../services/escalation.ts";
import {
  createErrorReportedEscalationHandler,
  ErrorEscalationTracker,
} from "./error-escalation.ts";

function payload(code: string): ErrorReportedPayload {
  return {
    runtime: {} as IAgentRuntime,
    scope: "TestScope",
    code,
    message: `failure ${code}`,
    context: { detail: code },
  };
}

describe("ErrorEscalationTracker", () => {
  it("does not escalate below the threshold and fires exactly on it", () => {
    const tracker = new ErrorEscalationTracker(3, 10 * 60 * 1000);
    const now = 1_000_000;
    expect(tracker.record("C", now).shouldEscalate).toBe(false);
    expect(tracker.record("C", now + 1000).shouldEscalate).toBe(false);
    const third = tracker.record("C", now + 2000);
    expect(third.shouldEscalate).toBe(true);
    expect(third.count).toBe(3);
  });

  it("resets the per-code window after firing so it does not spam", () => {
    const tracker = new ErrorEscalationTracker(3, 10 * 60 * 1000);
    const now = 1_000_000;
    tracker.record("C", now);
    tracker.record("C", now + 1);
    expect(tracker.record("C", now + 2).shouldEscalate).toBe(true);
    // Next two must NOT re-fire — the window was cleared on the crossing.
    expect(tracker.record("C", now + 3).shouldEscalate).toBe(false);
    expect(tracker.record("C", now + 4).shouldEscalate).toBe(false);
    // A fresh third crosses again.
    expect(tracker.record("C", now + 5).shouldEscalate).toBe(true);
  });

  it("drops occurrences that fall outside the window", () => {
    const tracker = new ErrorEscalationTracker(3, 10 * 60 * 1000);
    const base = 1_000_000;
    tracker.record("C", base);
    tracker.record("C", base + 1000);
    // This one is 11 minutes later — the first two have aged out, so it is
    // only the 1st in-window occurrence.
    const late = tracker.record("C", base + 11 * 60 * 1000);
    expect(late.shouldEscalate).toBe(false);
    expect(late.count).toBe(1);
  });

  it("tracks each code independently", () => {
    const tracker = new ErrorEscalationTracker(3, 10 * 60 * 1000);
    const now = 1_000_000;
    tracker.record("A", now);
    tracker.record("A", now);
    tracker.record("B", now);
    // A's third fires; B is still at one.
    expect(tracker.record("A", now).shouldEscalate).toBe(true);
    expect(tracker.record("B", now).shouldEscalate).toBe(false);
  });
});

describe("ERROR_REPORTED escalation handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts exactly one escalation per burst of threshold reports", async () => {
    const spy = vi
      .spyOn(EscalationService, "startEscalation")
      .mockResolvedValue({} as never);
    const runtime = {} as IAgentRuntime;
    const tracker = new ErrorEscalationTracker(3, 10 * 60 * 1000);
    const handler = createErrorReportedEscalationHandler(runtime, tracker, 10);

    await handler(payload("DB_DOWN"));
    await handler(payload("DB_DOWN"));
    expect(spy).not.toHaveBeenCalled();

    await handler(payload("DB_DOWN"));
    expect(spy).toHaveBeenCalledTimes(1);
    const [, reason, text] = spy.mock.calls[0];
    expect(reason).toContain("DB_DOWN");
    expect(reason).toContain("3");
    expect(text).toContain("failure DB_DOWN");

    // Further reports within the reset window do not spam.
    await handler(payload("DB_DOWN"));
    await handler(payload("DB_DOWN"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter reportError when escalation fails", async () => {
    vi.spyOn(EscalationService, "startEscalation").mockRejectedValue(
      new Error("send failed"),
    );
    const reportError = vi.fn();
    const runtime = { reportError } as unknown as IAgentRuntime;
    const tracker = new ErrorEscalationTracker(1, 10 * 60 * 1000);
    const handler = createErrorReportedEscalationHandler(runtime, tracker, 10);

    await expect(handler(payload("X"))).resolves.toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("EscalationService coalescing (real service)", () => {
  afterEach(() => {
    EscalationService._reset();
  });

  it("coalesces a second escalation into the active one", async () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "coalesce-test" },
      getRoomsForParticipant: async () => [],
      getRoom: async () => null,
      getWorld: async () => null,
      getService: () => null,
      getEntityById: async () => null,
      getMemoriesByRoomIds: async () => [],
      setCache: async () => true,
      getCache: async () => null,
      deleteCache: async () => true,
      sendMessageToTarget: async () => {},
    } as unknown as IAgentRuntime;

    const first = await EscalationService.startEscalation(
      runtime,
      "Systemic failure DB_DOWN reported 3 times",
      "first burst",
    );
    const second = await EscalationService.startEscalation(
      runtime,
      "Systemic failure DB_DOWN reported 3 times",
      "second burst",
    );

    expect(second.id).toBe(first.id);
    expect(second.text).toContain("first burst");
    expect(second.text).toContain("second burst");
    expect(EscalationService.getActiveEscalationSync()?.id).toBe(first.id);
  });
});
