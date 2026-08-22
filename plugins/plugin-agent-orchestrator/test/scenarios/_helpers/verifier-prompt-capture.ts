/**
 * Owns the reversible model-boundary observer used by deterministic verifier
 * scenarios while one scenario-runner runtime is reused across attempts.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioCleanupStep,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";

type ModelRuntime = Pick<IAgentRuntime, "useModel">;

function requireModelRuntime(runtime: unknown): ModelRuntime {
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    !("useModel" in runtime) ||
    typeof runtime.useModel !== "function"
  ) {
    throw new Error(
      "verifier prompt capture cleanup requires a runtime model boundary",
    );
  }
  return runtime as ModelRuntime;
}

const verifierPromptCaptureByRuntime = new WeakMap<
  ModelRuntime,
  {
    originalUseModel: ModelRuntime["useModel"];
    wrapper: ModelRuntime["useModel"];
  }
>();
const verifierPromptCaptureCleanupByAttempt = new WeakMap<object, () => void>();

function requireAttemptKey(ctx: ScenarioContext): object {
  if (!Array.isArray(ctx.turns)) {
    throw new Error("verifier prompt capture requires runner-owned turns");
  }
  return ctx.turns;
}

export function installAttemptScopedVerifierPromptCapture(
  runtime: ModelRuntime,
  capture: (prompt: string) => void,
): () => void {
  if (verifierPromptCaptureByRuntime.has(runtime)) {
    throw new Error(
      "verifier prompt capture is already installed for this runtime attempt",
    );
  }
  const originalUseModel = runtime.useModel;
  const useModel = originalUseModel.bind(runtime);
  const wrapper = (async (...args: Parameters<typeof runtime.useModel>) => {
    const [modelType, params] = args;
    const prompt = (params as { prompt?: string } | undefined)?.prompt ?? "";
    if (
      modelType === "TEXT_SMALL" &&
      prompt.includes("You are a demanding engineering manager")
    ) {
      capture(prompt);
    }
    return useModel(...args);
  }) as typeof runtime.useModel;
  runtime.useModel = wrapper;
  verifierPromptCaptureByRuntime.set(runtime, {
    originalUseModel,
    wrapper,
  });
  return () => uninstallAttemptScopedVerifierPromptCapture(runtime, wrapper);
}

function uninstallAttemptScopedVerifierPromptCapture(
  runtime: ModelRuntime,
  owner: ModelRuntime["useModel"],
): void {
  const installed = verifierPromptCaptureByRuntime.get(runtime);
  if (!installed) return;
  if (installed.wrapper !== owner) return;
  if (runtime.useModel !== installed.wrapper) {
    throw new Error(
      "cannot restore verifier prompt capture after runtime.useModel changed",
    );
  }
  runtime.useModel = installed.originalUseModel;
  verifierPromptCaptureByRuntime.delete(runtime);
}

/** Bind a successful installation's owner-scoped cleanup to one runner attempt. */
export function bindVerifierPromptCaptureCleanup(
  ctx: ScenarioContext,
  cleanup: () => void,
): void {
  const attemptKey = requireAttemptKey(ctx);
  if (verifierPromptCaptureCleanupByAttempt.has(attemptKey)) {
    throw new Error("verifier prompt capture cleanup is already bound");
  }
  verifierPromptCaptureCleanupByAttempt.set(attemptKey, cleanup);
}

export const verifierPromptCaptureCleanupStep = {
  type: "custom",
  name: "restore verifier prompt capture",
  apply: (ctx) => {
    if (!Array.isArray(ctx.turns)) return undefined;
    const attemptKey = ctx.turns;
    const cleanup = verifierPromptCaptureCleanupByAttempt.get(attemptKey);
    if (!cleanup) return undefined;
    requireModelRuntime(ctx.runtime);
    cleanup();
    verifierPromptCaptureCleanupByAttempt.delete(attemptKey);
    return undefined;
  },
} satisfies ScenarioCleanupStep;
