/**
 * Verifies the deterministic scenario verifier observer is attempt-scoped when
 * the scenario CLI reuses one runtime across consecutive scenario boundaries.
 */

import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../../../../packages/scenario-runner/src/executor";
import {
  bindVerifierPromptCaptureCleanup,
  installAttemptScopedVerifierPromptCapture,
  verifierPromptCaptureCleanupStep,
} from "../../test/scenarios/_helpers/verifier-prompt-capture";

vi.mock("@elizaos/plugin-local-inference/voice-workbench", () => ({}));

type ScenarioRuntime = Parameters<
  typeof installAttemptScopedVerifierPromptCapture
>[0];

function createRuntime(): ScenarioRuntime {
  return {
    actions: [],
    plugins: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    useModel: vi.fn(async () => "completion"),
  } as unknown as ScenarioRuntime;
}

describe("verifier prompt capture lifecycle", () => {
  it("leaves an unowned cleanup attempt inert", () => {
    expect(
      verifierPromptCaptureCleanupStep.apply?.({ runtime: undefined } as never),
    ).toBeUndefined();
  });

  it("restores the shared runtime after successful and failed scenario attempts", async () => {
    const runtime = createRuntime();
    const originalUseModel = runtime.useModel;
    const successfulCapture = vi.fn();
    const failedCapture = vi.fn();
    const options = {
      minJudgeScore: 0.8,
      providerName: "unit-test",
      turnTimeoutMs: 1_000,
    };

    const successful = await runScenario(
      {
        id: "verifier-capture-success",
        title: "Verifier capture success",
        domain: "agent-orchestrator",
        seed: [
          {
            type: "custom",
            apply: async (ctx) => {
              bindVerifierPromptCaptureCleanup(
                ctx,
                installAttemptScopedVerifierPromptCapture(
                  ctx.runtime,
                  successfulCapture,
                ),
              );
              await ctx.runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: "You are a demanding engineering manager",
              });
              return undefined;
            },
          },
        ],
        cleanup: [verifierPromptCaptureCleanupStep],
        turns: [],
      },
      runtime as never,
      options,
    );

    expect(successful.status).toBe("passed");
    expect(successfulCapture).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toBe(originalUseModel);

    const failed = await runScenario(
      {
        id: "verifier-capture-failure",
        title: "Verifier capture failure",
        domain: "agent-orchestrator",
        seed: [
          {
            type: "custom",
            apply: async (ctx) => {
              bindVerifierPromptCaptureCleanup(
                ctx,
                installAttemptScopedVerifierPromptCapture(
                  ctx.runtime,
                  failedCapture,
                ),
              );
              await ctx.runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: "You are a demanding engineering manager",
              });
              return undefined;
            },
          },
        ],
        cleanup: [verifierPromptCaptureCleanupStep],
        turns: [
          {
            kind: "message",
            name: "missing message service",
            text: "This turn fails after capture installation.",
          },
        ],
      },
      runtime as never,
      options,
    );

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("runtime.messageService is not initialized");
    expect(failedCapture).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toBe(originalUseModel);

    await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "You are a demanding engineering manager after both scenarios",
    });
    expect(successfulCapture).toHaveBeenCalledTimes(1);
    expect(failedCapture).toHaveBeenCalledTimes(1);
  });

  it("restores the original model boundary before the next scenario", async () => {
    const runtime = createRuntime();
    const originalUseModel = runtime.useModel;
    const firstCapture = vi.fn();
    const cleanupFirstAttempt = installAttemptScopedVerifierPromptCapture(
      runtime,
      firstCapture,
    );
    const firstWrapper = runtime.useModel;

    expect(firstWrapper).not.toBe(originalUseModel);
    await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "You are a demanding engineering manager",
    });
    expect(firstCapture).toHaveBeenCalledTimes(1);
    cleanupFirstAttempt();
    expect(runtime.useModel).toBe(originalUseModel);

    const secondCapture = vi.fn();
    const cleanupSecondAttempt = installAttemptScopedVerifierPromptCapture(
      runtime,
      secondCapture,
    );
    expect(runtime.useModel).not.toBe(originalUseModel);
    expect(runtime.useModel).not.toBe(firstWrapper);
    await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "You are a demanding engineering manager for attempt two",
    });
    expect(firstCapture).toHaveBeenCalledTimes(1);
    expect(secondCapture).toHaveBeenCalledTimes(1);
    cleanupSecondAttempt();
    expect(runtime.useModel).toBe(originalUseModel);
  });

  it("is idempotent after cleanup but refuses to discard a later wrapper", () => {
    const runtime = createRuntime();
    const cleanup = installAttemptScopedVerifierPromptCapture(runtime, vi.fn());
    cleanup();
    expect(() => cleanup()).not.toThrow();

    const secondCleanup = installAttemptScopedVerifierPromptCapture(
      runtime,
      vi.fn(),
    );
    runtime.useModel = vi.fn(
      async () => "later wrapper",
    ) as typeof runtime.useModel;
    expect(() => secondCleanup()).toThrow("runtime.useModel changed");
  });

  it("does not let a rejected overlapping attempt clean up the winner", async () => {
    const runtime = createRuntime();
    const originalUseModel = runtime.useModel;
    const winningCapture = vi.fn();
    let releaseWinner!: () => void;
    let announceWinner!: () => void;
    const winnerInstalled = new Promise<void>((resolve) => {
      announceWinner = resolve;
    });
    const loserFinished = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const options = {
      minJudgeScore: 0.8,
      providerName: "unit-test",
      turnTimeoutMs: 1_000,
    };

    const winner = runScenario(
      {
        id: "verifier-overlap-winner",
        title: "Verifier overlap winner",
        domain: "agent-orchestrator",
        seed: [
          {
            type: "custom",
            apply: async (ctx) => {
              bindVerifierPromptCaptureCleanup(
                ctx,
                installAttemptScopedVerifierPromptCapture(
                  ctx.runtime,
                  winningCapture,
                ),
              );
              announceWinner();
              await loserFinished;
              await ctx.runtime.useModel(ModelType.TEXT_SMALL, {
                prompt:
                  "You are a demanding engineering manager after loser cleanup",
              });
              return undefined;
            },
          },
        ],
        cleanup: [verifierPromptCaptureCleanupStep],
        turns: [],
      },
      runtime as never,
      options,
    );
    await winnerInstalled;
    const loser = await runScenario(
      {
        id: "verifier-overlap-loser",
        title: "Verifier overlap loser",
        domain: "agent-orchestrator",
        seed: [
          {
            type: "custom",
            apply: (ctx) => {
              bindVerifierPromptCaptureCleanup(
                ctx,
                installAttemptScopedVerifierPromptCapture(ctx.runtime, vi.fn()),
              );
              return undefined;
            },
          },
        ],
        cleanup: [verifierPromptCaptureCleanupStep],
        turns: [],
      },
      runtime as never,
      options,
    );
    releaseWinner();
    const winningReport = await winner;

    expect(loser.status).toBe("failed");
    expect(loser.error).toContain("already installed");
    expect(winningReport.status).toBe("passed");
    expect(winningCapture).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toBe(originalUseModel);
  });
});
