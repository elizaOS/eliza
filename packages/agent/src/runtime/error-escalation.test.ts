/**
 * Tests for the repeat-failure → owner-escalation wiring: the sliding-window
 * tracker's threshold + reset (no per-error spam), the ERROR_REPORTED handler
 * that fires exactly one escalation per burst, and the real
 * EscalationService.startEscalation coalescing an already-active escalation.
 */

import type { ErrorReportedPayload, IAgentRuntime } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscalationService } from "../services/escalation.ts";
import {
  createErrorReportedEscalationHandler,
  ErrorEscalationTracker,
  registerErrorEscalation,
  resolveThreshold,
  resolveWindowMs,
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

  it("preserves fractional configured minutes in owner-facing diagnostics", async () => {
    const spy = vi
      .spyOn(EscalationService, "startEscalation")
      .mockResolvedValue({} as never);
    const registerEvent = vi.fn();
    const runtime = {
      getSetting: (key: string) =>
        key === "ERROR_ESCALATION_THRESHOLD" ? "2" : "1.5",
      registerEvent,
    } as unknown as IAgentRuntime;

    registerErrorEscalation(runtime);
    const handler = registerEvent.mock.calls[0][1] as (
      event: ErrorReportedPayload,
    ) => Promise<void>;

    await handler(payload("FRACTIONAL_WINDOW"));
    await handler(payload("FRACTIONAL_WINDOW"));

    const [, reason] = spy.mock.calls[0];
    expect(reason).toContain("within 1.5m");
    expect(reason).not.toContain("within 2m");
  });

  it("never escalates internal scheduler-plumbing codes into owner chat (SHADOW-ACCOUNT-DEBUG)", async () => {
    const spy = vi
      .spyOn(EscalationService, "startEscalation")
      .mockResolvedValue({} as never);
    const runtime = {} as IAgentRuntime;
    // Threshold 1: a single quiet-code report would escalate if not filtered.
    const tracker = new ErrorEscalationTracker(1, 10 * 60 * 1000);
    const handler = createErrorReportedEscalationHandler(runtime, tracker, 10);

    // The exact loop that narrated into Shadow's chat 9x.
    await handler(payload("TASK_WORKER_MISSING"));
    await handler(payload("TASK_TICK_FAILED"));
    await handler(payload("TASK_QUERY_FAILED"));
    await handler(payload("TASK_ORPHAN_QUARANTINE_FAILED"));
    expect(spy).not.toHaveBeenCalled();

    // A real, non-quiet code still escalates on the same tracker.
    await handler(payload("DB_DOWN"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never escalates diagnostic-only persistence failures into owner chat", async () => {
    const spy = vi
      .spyOn(EscalationService, "startEscalation")
      .mockResolvedValue({} as never);
    const tracker = new ErrorEscalationTracker(1, 10 * 60 * 1000);
    const handler = createErrorReportedEscalationHandler(
      {} as IAgentRuntime,
      tracker,
      10,
    );

    for (const scope of [
      "TrajectoryChildStep.start",
      "TrajectoryActionStep.normalize",
      "TrajectoryActionStep.complete",
      "Trajectory.linkChild",
    ]) {
      await handler({
        ...payload("TRAJECTORY_DIAGNOSTIC_FAILURE"),
        scope,
        context: { diagnosticOnly: true },
      });
    }
    expect(spy).not.toHaveBeenCalled();
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

describe("error-escalation configuration", () => {
  function runtimeWithSettings(
    settings: Record<string, string | undefined>,
  ): IAgentRuntime {
    return {
      getSetting: (key: string) => settings[key],
    } as unknown as IAgentRuntime;
  }

  function expectInvalidConfiguration(
    resolve: () => unknown,
    setting: string,
    configured: string,
  ): void {
    let thrown: unknown;
    try {
      resolve();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      code: "ERROR_ESCALATION_CONFIG_INVALID",
      severity: "fatal",
      context: {
        setting,
        configured,
      },
    });
  }

  it("uses defaults for unset, empty, and whitespace-only settings", () => {
    expect(resolveThreshold(runtimeWithSettings({}))).toBe(3);
    for (const blank of ["", "  "]) {
      expect(
        resolveThreshold(
          runtimeWithSettings({ ERROR_ESCALATION_THRESHOLD: blank }),
        ),
      ).toBe(3);
    }
    expect(resolveWindowMs(runtimeWithSettings({}))).toBe(10 * 60_000);
    for (const blank of ["", "  "]) {
      expect(
        resolveWindowMs(
          runtimeWithSettings({ ERROR_ESCALATION_WINDOW_MINUTES: blank }),
        ),
      ).toBe(10 * 60_000);
    }
  });

  it.each([
    ["5", 5],
    ["1", 1],
  ])("resolves threshold %s", (configured, expected) => {
    expect(
      resolveThreshold(
        runtimeWithSettings({ ERROR_ESCALATION_THRESHOLD: configured }),
      ),
    ).toBe(expected);
  });

  it.each([
    ["30", 30 * 60_000],
    ["1.5", 90_000],
    ["0.5", 30_000],
  ])("resolves window %s minutes", (configured, expected) => {
    expect(
      resolveWindowMs(
        runtimeWithSettings({ ERROR_ESCALATION_WINDOW_MINUTES: configured }),
      ),
    ).toBe(expected);
  });

  it.each(["3oops", "1e2", "0", "-2", "2.5", "abc"])(
    "rejects invalid threshold %s",
    (configured) => {
      expectInvalidConfiguration(
        () =>
          resolveThreshold(
            runtimeWithSettings({ ERROR_ESCALATION_THRESHOLD: configured }),
          ),
        "ERROR_ESCALATION_THRESHOLD",
        configured,
      );
    },
  );

  it.each(["10abc", "0", "-5", "abc", "Infinity", "NaN"])(
    "rejects invalid window %s",
    (configured) => {
      expectInvalidConfiguration(
        () =>
          resolveWindowMs(
            runtimeWithSettings({
              ERROR_ESCALATION_WINDOW_MINUTES: configured,
            }),
          ),
        "ERROR_ESCALATION_WINDOW_MINUTES",
        configured,
      );
    },
  );

  it("rejects a finite minute value that overflows safe milliseconds", () => {
    const configured = "9".repeat(308);
    expectInvalidConfiguration(
      () =>
        resolveWindowMs(
          runtimeWithSettings({ ERROR_ESCALATION_WINDOW_MINUTES: configured }),
        ),
      "ERROR_ESCALATION_WINDOW_MINUTES",
      configured,
    );
  });

  it("propagates an invalid threshold during registration", () => {
    const configured = "3oops";
    const runtime = {
      getSetting: (key: string) =>
        key === "ERROR_ESCALATION_THRESHOLD" ? configured : undefined,
      registerEvent: vi.fn(),
    } as unknown as IAgentRuntime;

    expectInvalidConfiguration(
      () => registerErrorEscalation(runtime),
      "ERROR_ESCALATION_THRESHOLD",
      configured,
    );
    expect(runtime.registerEvent).not.toHaveBeenCalled();
  });

  it("propagates an invalid window during registration", () => {
    const configured = "invalid-window";
    const runtime = {
      getSetting: (key: string) =>
        key === "ERROR_ESCALATION_THRESHOLD" ? "3" : configured,
      registerEvent: vi.fn(),
    } as unknown as IAgentRuntime;

    expectInvalidConfiguration(
      () => registerErrorEscalation(runtime),
      "ERROR_ESCALATION_WINDOW_MINUTES",
      configured,
    );
    expect(runtime.registerEvent).not.toHaveBeenCalled();
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
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      first.id,
    );
  });
});
