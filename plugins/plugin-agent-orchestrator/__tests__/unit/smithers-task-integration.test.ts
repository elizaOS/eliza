/**
 * Verifies shouldUseSmithersTaskRunner.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AcpTaskService,
  runDurableTask,
  shouldUseSmithersTaskRunner,
} from "../../src/services/smithers-task-integration";

const TIMEOUT = 60_000;
const uniqueSession = () => ({
  sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
});

describe("shouldUseSmithersTaskRunner", () => {
  it('defaults on; off only when explicitly "0"', () => {
    const prev = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
    try {
      delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
      expect(shouldUseSmithersTaskRunner()).toBe(true);
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
      expect(shouldUseSmithersTaskRunner()).toBe(false);
      process.env.ELIZA_ORCHESTRATOR_SMITHERS = "1";
      expect(shouldUseSmithersTaskRunner()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
      else process.env.ELIZA_ORCHESTRATOR_SMITHERS = prev;
    }
  });
});

describe("runDurableTask", () => {
  it(
    "drives the spawned session to completion and captures the response",
    async () => {
      const sendPrompt = vi.fn(async () => ({
        stopReason: "end_turn",
        finalText: "all done",
      }));
      const service: AcpTaskService = { sendPrompt };
      const result = await runDurableTask(
        service,
        uniqueSession(),
        "do the thing",
        {},
      );
      expect(result.status).toBe("completed");
      expect(result.lastResponse).toBe("all done");
      expect(result.turns).toBe(1);
      expect(sendPrompt).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    "falls back to sendToSession when sendPrompt is absent",
    async () => {
      const sendToSession = vi.fn(async () => ({
        stopReason: "end_turn",
        finalText: "via sendToSession",
      }));
      const service: AcpTaskService = { sendToSession };
      const result = await runDurableTask(
        service,
        uniqueSession(),
        "do it",
        {},
      );
      expect(result.status).toBe("completed");
      expect(result.lastResponse).toBe("via sendToSession");
      expect(sendToSession).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    "propagates a prompt error (even when a single-turn loop would swallow it)",
    async () => {
      const service: AcpTaskService = {
        sendPrompt: async () => ({ stopReason: "error", error: "boom" }),
      };
      // The prompt error must fail the run (not silently succeed); it surfaces as a
      // run-failure (the underlying 'boom' is in the subprocess stderr).
      await expect(
        runDurableTask(service, uniqueSession(), "x", {}),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
