/**
 * Verify-retry delivery into a busy session, and fail-verdict chat truthfulness.
 *
 * Incident shape (color-pop, Aug 1 + Aug 2): a create-app `task_complete` fans
 * out to several independent consumers. While the app verifier ran (~3s), the
 * interruption-decider inbox flush delivered a user follow-up that had been
 * queued mid-build into the now-idle session, starting a new turn. The
 * verifier's FAIL retry then hit the transport's transient "ACP session is
 * already busy" claim, and the old one-shot `sendPrompt` treated it as
 * terminal: escalation dispatched, session stopped (killing the user's
 * follow-up turn), and — because `escalation` mapped to no completion status —
 * origin chat got only the teardown's false "<label> stopped before
 * completion" for an app that was registered and live.
 *
 * These tests pin the two structural fixes:
 *  1. the retry prompt waits out a transient occupant turn (bounded poll on
 *     the busy classification only, same pattern as parent-agent-dispatch's
 *     deliverReplyToChild), and a busy-deadline failure un-records the
 *     retryCount bump for the retry turn that never ran;
 *  2. a dispatched FAIL verdict (escalation) synthesizes an `errored`
 *     completion to origin chat carrying the real verdict + deliverable, and
 *     its dedupe-slot claim suppresses the trailing teardown `stopped` — the
 *     fail-side analog of the validator-pass suppression.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { isSessionBusyError } from "../services/parent-agent-dispatch.js";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

const SESSION = "sess-validator";

function flushMicrotasks(rounds = 6): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return p;
}

interface HarnessOptions {
  /** Per-call behavior for acp.sendPrompt; throw to simulate transport errors. */
  sendPrompt: (call: number) => Promise<{ stopReason: string }>;
  /** Verdict payload the app-verification service returns. */
  verdict: Record<string, unknown>;
  sessionMetadata?: Record<string, unknown>;
}

function makeHarness(opts: HarnessOptions): {
  service: SwarmCoordinatorService;
  emit: (sessionId: string, event: string, data: unknown) => void;
  completions: Array<{ status: string; completionSummary: string }>;
  swarmEvents: string[];
  counters: { sendPromptCalls: () => number };
  metadataPatches: Array<Record<string, unknown>>;
  stopSessionCalls: string[];
  durableVerdicts: Array<{
    sessionId: string;
    passed: boolean;
    summary: string;
  }>;
} {
  const handlers: Array<
    (sessionId: string, event: string, data: unknown) => void
  > = [];
  const emit = (sessionId: string, event: string, data: unknown): void => {
    for (const h of [...handlers]) h(sessionId, event, data);
  };
  let sendPromptCalls = 0;
  const metadataPatches: Array<Record<string, unknown>> = [];
  const stopSessionCalls: string[] = [];
  const sessionMetadata = opts.sessionMetadata ?? {};
  const acp = {
    onSessionEvent(
      handler: (sessionId: string, event: string, data: unknown) => void,
    ) {
      handlers.push(handler);
      return () => {};
    },
    getSession: async (sessionId: string) =>
      sessionId === SESSION
        ? {
            id: SESSION,
            agentType: "codex",
            workdir: "/tmp/verify-retry-busy-test",
            status: "ready",
            metadata: sessionMetadata,
          }
        : undefined,
    sendPrompt: async () => {
      sendPromptCalls += 1;
      return opts.sendPrompt(sendPromptCalls);
    },
    updateSessionMetadata: async (
      _sessionId: string,
      patch: Record<string, unknown>,
    ) => {
      metadataPatches.push(patch);
      Object.assign(sessionMetadata, patch);
    },
    stopSession: async (sessionId: string) => {
      stopSessionCalls.push(sessionId);
      // Real teardown emits the session's terminal `stopped` through the same
      // event stream (closeSession in AcpService) — the event whose synthesis
      // produced the false "stopped before completion".
      emit(sessionId, "stopped", {});
    },
  };
  const verification = {
    verifyApp: async () => opts.verdict,
  };
  const durableVerdicts: Array<{
    sessionId: string;
    passed: boolean;
    summary: string;
  }> = [];
  const taskService = {
    applyCustomValidatorResult: async (
      sessionId: string,
      result: { passed: boolean; summary: string },
    ) => {
      durableVerdicts.push({ sessionId, ...result });
      return null;
    },
  };
  const runtime = {
    getService: (type: string) => {
      if (type === AcpService.serviceType) return acp;
      if (type === "app-verification") return verification;
      if (type === OrchestratorTaskService.serviceType) return taskService;
      return null;
    },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new SwarmCoordinatorService(runtime);
  (service as unknown as { bindToAcp: () => void }).bindToAcp();
  const completions: Array<{ status: string; completionSummary: string }> = [];
  service.setSwarmCompleteCallback(async (payload) => {
    for (const task of payload.tasks) {
      completions.push({
        status: task.status,
        completionSummary: task.completionSummary,
      });
    }
  });
  const swarmEvents: string[] = [];
  service.subscribe((event) => {
    swarmEvents.push(event.type);
  });
  return {
    service,
    emit,
    completions,
    swarmEvents,
    counters: { sendPromptCalls: () => sendPromptCalls },
    metadataPatches,
    stopSessionCalls,
    durableVerdicts,
  };
}

const FAIL_VERDICT = {
  verdict: "fail",
  checks: [{ label: "lint", passed: false }],
};
const PASS_VERDICT = {
  verdict: "pass",
  checks: [
    { label: "typecheck", passed: true },
    { label: "lint", passed: true },
    { label: "test", passed: true },
    { label: "build", passed: true },
  ],
};

function retryTaskCompleteData(): Record<string, unknown> {
  return {
    label: "create-app:color-pop",
    response: "Deployed and live at https://example.org/apps/color-pop/",
    validator: { service: "app-verification", method: "verifyApp", params: {} },
    onVerificationFail: "retry",
    maxRetries: 1,
    retryCount: 0,
  };
}

const busyError = () => new Error(`ACP session is already busy: ${SESSION}`);

describe("verify-retry delivery tolerates a transient busy session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out an occupant turn and delivers the retry instead of escalating", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = makeHarness({
      // First attempt lands while the flushed user follow-up turn holds the
      // slot; the second attempt (after one poll) finds the session idle.
      sendPrompt: async (call) => {
        if (call === 1) throw busyError();
        return { stopReason: "end_turn" };
      },
      verdict: FAIL_VERDICT,
    });

    h.emit(SESSION, "task_complete", retryTaskCompleteData());
    await flushMicrotasks();
    expect(h.counters.sendPromptCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_100);
    await flushMicrotasks();

    // The retry was delivered: no escalation, no teardown, retry recorded.
    expect(h.counters.sendPromptCalls()).toBe(2);
    expect(h.stopSessionCalls).toEqual([]);
    expect(h.completions).toEqual([]);
    expect(h.swarmEvents).not.toContain("escalation");
    expect(h.metadataPatches).toEqual([{ retryCount: 1 }]);
    expect(h.durableVerdicts).toEqual([]);

    await h.service.stop();
  });

  it("escalates after the busy deadline, un-records the never-ran retry, and posts the fail verdict once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = makeHarness({
      sendPrompt: async () => {
        throw busyError();
      },
      verdict: FAIL_VERDICT,
    });

    h.emit(SESSION, "task_complete", retryTaskCompleteData());
    await flushMicrotasks();
    // Ride out the whole busy deadline.
    await vi.advanceTimersByTimeAsync(305_000);
    await flushMicrotasks();

    // The bump was reverted: metadata never claims a retry that never ran.
    expect(h.metadataPatches).toEqual([{ retryCount: 1 }, { retryCount: 0 }]);
    // The fail verdict reached origin chat as ONE errored completion carrying
    // the verdict + the live deliverable — and the teardown `stopped` that
    // followed did not add a false "stopped before completion".
    expect(h.stopSessionCalls).toEqual([SESSION]);
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]?.status).toBe("errored");
    expect(h.completions[0]?.completionSummary).toContain(
      "App verification failed: lint",
    );
    expect(h.completions[0]?.completionSummary).toContain(
      "https://example.org/apps/color-pop/",
    );
    expect(h.swarmEvents).toContain("escalation");
    expect(h.durableVerdicts).toMatchObject([
      { sessionId: SESSION, passed: false },
    ]);

    await h.service.stop();
  });

  it("still treats a non-busy transport error as terminal (no poll loop)", async () => {
    const h = makeHarness({
      sendPrompt: async () => {
        throw new Error(
          "Sub-agent state was lost (process exited without persisting). No automatic action taken.",
        );
      },
      verdict: FAIL_VERDICT,
    });

    h.emit(SESSION, "task_complete", retryTaskCompleteData());
    await flushMicrotasks();

    // One attempt, straight to escalation; the bump is NOT reverted for a
    // non-busy failure (the classification is busy-specific).
    expect(h.counters.sendPromptCalls()).toBe(1);
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]?.status).toBe("errored");
    expect(h.stopSessionCalls).toEqual([SESSION]);
    expect(h.durableVerdicts).toMatchObject([
      { sessionId: SESSION, passed: false },
    ]);

    await h.service.stop();
  });
});

describe("dispatched FAIL verdict owns the session's user-facing terminal", () => {
  it("projects a PASS onto the durable task before announcing completion", async () => {
    const h = makeHarness({
      sendPrompt: async () => ({ stopReason: "end_turn" }),
      verdict: PASS_VERDICT,
    });

    h.emit(SESSION, "task_complete", {
      label: "create-app:color-pop",
      response:
        'APP_CREATE_DONE {"appName":"color-pop","files":["src/index.tsx"],"tests":{"passed":1,"failed":0},"lint":"ok","typecheck":"ok"}',
      validator: {
        service: "app-verification",
        method: "verifyApp",
        params: {},
      },
    });
    await flushMicrotasks();

    expect(h.durableVerdicts).toMatchObject([
      {
        sessionId: SESSION,
        passed: true,
        summary: "App verification passed.",
      },
    ]);
    expect(h.swarmEvents).toContain("task_complete");

    await h.service.stop();
  });

  it("posts errored to origin chat and suppresses the teardown stopped (no-retry fail)", async () => {
    const h = makeHarness({
      sendPrompt: async () => ({ stopReason: "end_turn" }),
      verdict: FAIL_VERDICT,
    });

    // No onVerificationFail: the FAIL dispatches escalation immediately.
    h.emit(SESSION, "task_complete", {
      label: "create-app:color-pop",
      response: "Deployed and live at https://example.org/apps/color-pop/",
      validator: {
        service: "app-verification",
        method: "verifyApp",
        params: {},
      },
    });
    await flushMicrotasks();

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]?.status).toBe("errored");
    expect(h.completions[0]?.completionSummary).toContain(
      "App verification failed: lint",
    );
    // The pre-fix bug: this array ended as [{ status: "stopped", ... }] — the
    // generic "stopped before completion" — with the fail verdict dropped.
    expect(h.completions.some((c) => c.status === "stopped")).toBe(false);
    expect(h.durableVerdicts).toMatchObject([
      { sessionId: SESSION, passed: false },
    ]);

    await h.service.stop();
  });

  it("a genuine stop with no dispatched verdict still synthesizes (fail-open)", async () => {
    const h = makeHarness({
      sendPrompt: async () => ({ stopReason: "end_turn" }),
      verdict: FAIL_VERDICT,
    });

    h.emit(SESSION, "stopped", { label: "create-app:color-pop" });
    await flushMicrotasks();

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]?.status).toBe("stopped");

    await h.service.stop();
  });
});

describe("isSessionBusyError classification", () => {
  it("matches the transport's busy rejection and nothing else", () => {
    expect(isSessionBusyError(busyError())).toBe(true);
    expect(isSessionBusyError(new Error("session not found"))).toBe(false);
    expect(isSessionBusyError("ACP session is already busy")).toBe(false);
  });
});
