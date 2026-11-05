/**
 * TaskWatchdogService prod delivery receipts.
 *
 * `AcpService.sendToSession` is `sendPrompt`: it throws only for a missing
 * or busy session, and reports a cancelled, stopped, or errored turn as a
 * resolved `PromptResult` receipt instead (see `undeliveredReason` in
 * api/agent-routes.ts). The watchdog used to treat any resolve as a
 * delivered prod, so a prod whose turn settled abnormally still consumed
 * the session's one prod for that stall: no later tick retried it, the log
 * said "prodding", and the session stayed in the stalled set the
 * ACTIVE_SUB_AGENTS provider reads.
 */
import { describe, expect, it, vi } from "vitest";
import {
  STALL_GRILL_PROMPT,
  TaskWatchdogService,
} from "../services/task-watchdog-service.js";

const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = 1_700_000_000_000;

function receipt(stopReason: string, error?: string) {
  return {
    sessionId: SESSION_ID,
    response: "",
    finalText: "",
    stopReason,
    durationMs: 1,
    ...(error ? { error } : {}),
  };
}

function makeWatchdog(sendToSession: (id: string, text: string) => unknown) {
  const acp = {
    listSessions: async () => [
      {
        id: SESSION_ID,
        status: "running",
        // Idle 10 minutes against the default 3-minute stall threshold.
        lastActivityAt: new Date(NOW - 10 * 60_000),
        metadata: {},
      },
    ],
    sendToSession: vi.fn(sendToSession),
  };
  const runtime = {
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SUBPROCESS_SERVICE" ? acp : undefined,
  };
  const watchdog = new TaskWatchdogService(runtime as never);
  return { acp, watchdog };
}

describe("TaskWatchdogService prod delivery receipt", () => {
  it("keeps the session prod-eligible after an error-carrying receipt", async () => {
    const { acp, watchdog } = makeWatchdog(async () =>
      receipt("end_turn", "child exited"),
    );
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
    expect(watchdog.getStalledSessionIds()).not.toContain(SESSION_ID);
    // The next tick retries the prod instead of skipping the session.
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledTimes(2);
  });

  it.each(["cancelled", "stopped", "error"])(
    "keeps the session prod-eligible after a %s receipt",
    async (stopReason) => {
      const { acp, watchdog } = makeWatchdog(async () => receipt(stopReason));
      await watchdog.runOnce(NOW);
      expect(acp.sendToSession).toHaveBeenCalledTimes(1);
      expect(watchdog.getStalledSessionIds()).not.toContain(SESSION_ID);
      await watchdog.runOnce(NOW);
      expect(acp.sendToSession).toHaveBeenCalledTimes(2);
    },
  );

  it("consumes the one prod for the stall after a delivered receipt", async () => {
    const { acp, watchdog } = makeWatchdog(async () => receipt("end_turn"));
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledWith(
      SESSION_ID,
      STALL_GRILL_PROMPT,
    );
    expect(watchdog.getStalledSessionIds()).toContain(SESSION_ID);
    // Once per stall is the design: a delivered prod is not repeated.
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
  });

  it("treats a receipt-less resolve as delivered", async () => {
    const { acp, watchdog } = makeWatchdog(async () => undefined);
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
    expect(watchdog.getStalledSessionIds()).toContain(SESSION_ID);
  });

  it("retries on the next tick after a thrown send failure", async () => {
    const { acp, watchdog } = makeWatchdog(async () => {
      throw new Error("ACP session is already busy");
    });
    await watchdog.runOnce(NOW);
    expect(watchdog.getStalledSessionIds()).not.toContain(SESSION_ID);
    await watchdog.runOnce(NOW);
    expect(acp.sendToSession).toHaveBeenCalledTimes(2);
  });
});
