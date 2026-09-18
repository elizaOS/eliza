/** Assistant owns structured prompt execution and scheduled batching. */
import type { IAgentRuntime, TaskWorker } from "@elizaos/core";
import { resolvePromptBatcherSettings } from "../utils/prompt-batcher/config.ts";
import { PromptBatcher, PromptDispatcher } from "../utils/prompt-batcher.ts";
import { StructuredPromptExecutor } from "./structured-prompt/executor.ts";

const reasoning = new WeakMap<
  IAgentRuntime,
  {
    batcher: PromptBatcher;
    worker: TaskWorker;
    execute: IAgentRuntime["dynamicPromptExecFromState"];
  }
>();

export function getAssistantPromptBatcher(
  runtime: IAgentRuntime,
): PromptBatcher | undefined {
  return reasoning.get(runtime)?.batcher;
}

export function installAssistantReasoning(
  runtime: IAgentRuntime,
): PromptBatcher {
  if (reasoning.has(runtime))
    throw new Error("Assistant prompt batcher already installed");
  const settings = resolvePromptBatcherSettings();
  if (runtime.structuredPromptExecutor)
    throw new Error("Structured prompt executor already installed");
  const executor = new StructuredPromptExecutor(runtime);
  const execute = executor.dynamicPromptExecFromState.bind(executor);
  const batcher = new PromptBatcher(
    runtime,
    new PromptDispatcher(settings.dispatcher),
    settings.batcher,
  );
  const worker: TaskWorker = {
    name: "BATCHER_DRAIN",
    async execute(_runtime, options) {
      if (typeof options.affinityKey === "string" && options.affinityKey) {
        await batcher.drainAffinityGroup(options.affinityKey);
      }
    },
  };
  runtime.registerTaskWorker(worker);
  runtime.structuredPromptExecutor = execute;
  reasoning.set(runtime, { batcher, worker, execute });
  return batcher;
}

export function disposeAssistantReasoning(runtime: IAgentRuntime): void {
  const owned = reasoning.get(runtime);
  if (!owned) return;
  owned.batcher.dispose();
  if (runtime.structuredPromptExecutor === owned.execute) {
    runtime.structuredPromptExecutor = undefined;
  }
  if (runtime.getTaskWorker(owned.worker.name) === owned.worker) {
    runtime.unregisterTaskWorker(owned.worker.name);
  }
  reasoning.delete(runtime);
}
