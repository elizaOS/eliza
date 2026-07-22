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
const tenantId = "00000000-0000-4000-8000-000000000001";
const cancellation = () => vi.fn(async () => undefined);

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
  it("fails before spawning Smithers when ACP cancellation is unavailable", async () => {
    const service: AcpTaskService = {
      sendPrompt: async () => ({ stopReason: "end_turn", finalText: "done" }),
    };

    await expect(
      runDurableTask(service, uniqueSession(), "x", { tenantId }),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "ACP_TASK_CANCEL_UNAVAILABLE",
    });
  });

  it(
    "drives the spawned session to completion and captures the response",
    async () => {
      const sendPrompt = vi.fn(async () => ({
        stopReason: "end_turn",
        finalText: "all done",
      }));
      const service: AcpTaskService = {
        sendPrompt,
        cancelSession: cancellation(),
      };
      const result = await runDurableTask(
        service,
        uniqueSession(),
        "do the thing",
        { tenantId },
      );
      expect(result.status).toBe("completed");
      expect(result.lastResponse).toBe("all done");
      expect(result.turns).toBe(1);
      expect(sendPrompt).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    "recovers a completed response without another ACP prompt after restart",
    async () => {
      const session = uniqueSession();
      const durableResponse = `durable-${"x".repeat(128 * 1024)}-tail`;
      const sendPrompt = vi.fn(async () => ({
        stopReason: "end_turn",
        finalText: durableResponse,
      }));
      const service: AcpTaskService = {
        sendPrompt,
        cancelSession: cancellation(),
      };

      const first = await runDurableTask(service, session, "do it once", {
        tenantId,
      });
      expect(first.lastResponse).toBe(durableResponse);
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      sendPrompt.mockClear();
      const resumed = await runDurableTask(service, session, "do it once", {
        tenantId,
      });
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(resumed.lastResponse).toBe(durableResponse);
      expect(resumed.status).toBe("completed");
    },
    TIMEOUT,
  );

  it(
    "sends Continue after a crash instead of replaying the initial prompt",
    async () => {
      const session = uniqueSession();
      const controller = new AbortController();
      const initialPrompt = "implement the durable workflow";
      const firstPrompts: string[] = [];
      let rejectInterruptedPrompt: ((error: Error) => void) | undefined;
      const firstService: AcpTaskService = {
        sendPrompt: async (_sessionId, text) => {
          firstPrompts.push(text);
          if (firstPrompts.length <= 2) {
            return {
              stopReason: "max_tokens",
              finalText: `partial-${firstPrompts.length}`,
            };
          }
          return new Promise((_, reject) => {
            rejectInterruptedPrompt = reject;
            queueMicrotask(() => controller.abort());
          });
        },
        cancelSession: async () => {
          rejectInterruptedPrompt?.(new Error("parent crashed"));
        },
      };

      await expect(
        runDurableTask(firstService, session, initialPrompt, {
          tenantId,
          maxTurns: 4,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "SMITHERS_TASK_ABORTED" });
      expect(firstPrompts).toHaveLength(3);

      const resumedPrompts: string[] = [];
      const resumedService: AcpTaskService = {
        sendPrompt: async (_sessionId, text) => {
          resumedPrompts.push(text);
          return {
            stopReason: "end_turn",
            finalText: "finished after restart",
          };
        },
        cancelSession: cancellation(),
      };
      const resumed = await runDurableTask(
        resumedService,
        session,
        initialPrompt,
        { tenantId, maxTurns: 4 },
      );

      expect(resumedPrompts).toEqual([
        "Continue working on the task. Reply when complete.",
      ]);
      expect(resumedPrompts).not.toContain(initialPrompt);
      expect(resumed.turns).toBe(3);
      expect(resumed.lastResponse).toBe("finished after restart");
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
      const service: AcpTaskService = {
        sendToSession,
        cancelSession: cancellation(),
      };
      const result = await runDurableTask(service, uniqueSession(), "do it", {
        tenantId,
      });
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
        cancelSession: cancellation(),
      };
      // The prompt error must fail the run (not silently succeed); it surfaces as a
      // run-failure (the underlying 'boom' is in the subprocess stderr).
      await expect(
        runDurableTask(service, uniqueSession(), "x", { tenantId }),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "rejects a clean turn that completes without a response",
    async () => {
      const service: AcpTaskService = {
        sendPrompt: async () => ({ stopReason: "end_turn" }),
        cancelSession: cancellation(),
      };

      await expect(
        runDurableTask(service, uniqueSession(), "x", { tenantId }),
      ).rejects.toMatchObject({
        name: "ElizaError",
        code: "SMITHERS_TASK_RESPONSE_MISSING",
      });
    },
    TIMEOUT,
  );

  it(
    "rejects a truncated run instead of emitting task completion",
    async () => {
      const service: AcpTaskService = {
        sendPrompt: async () => ({
          stopReason: "max_tokens",
          finalText: "partial output",
        }),
        cancelSession: cancellation(),
      };

      await expect(
        runDurableTask(service, uniqueSession(), "x", { tenantId }),
      ).rejects.toMatchObject({
        name: "ElizaError",
        code: "SMITHERS_TASK_INCOMPLETE",
      });
    },
    TIMEOUT,
  );

  it(
    "cancels an in-flight ACP turn and prevents its delayed side effect",
    async () => {
      const controller = new AbortController();
      let delayedSideEffect = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectPrompt: ((error: Error) => void) | undefined;
      const sendPrompt = vi.fn(
        () =>
          new Promise<{
            stopReason: string;
            finalText: string;
          }>((resolve, reject) => {
            rejectPrompt = reject;
            timer = setTimeout(() => {
              delayedSideEffect = true;
              resolve({ stopReason: "end_turn", finalText: "too late" });
            }, 250);
          }),
      );
      const cancelSession = vi.fn(async () => {
        if (timer) clearTimeout(timer);
        rejectPrompt?.(new Error("cancelled by parent"));
      });
      const service: AcpTaskService = { sendPrompt, cancelSession };

      const run = runDurableTask(service, uniqueSession(), "keep working", {
        tenantId,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      });
      controller.abort();

      await expect(run).rejects.toMatchObject({
        name: "ElizaError",
        code: "SMITHERS_TASK_ABORTED",
      });
      expect(cancelSession).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(delayedSideEffect).toBe(false);
    },
    TIMEOUT,
  );
});
