/** Assistant batching owns its scheduled drains; an empty kernel owns none. */
import type { IAgentRuntime, TaskWorker } from "@elizaos/core";
import { resolvePromptBatcherSettings } from "../utils/prompt-batcher/config.ts";
import { PromptBatcher, PromptDispatcher } from "../utils/prompt-batcher.ts";

const batchers = new WeakMap<
  IAgentRuntime,
  { batcher: PromptBatcher; worker: TaskWorker }
>();

export function getAssistantPromptBatcher(
  runtime: IAgentRuntime,
): PromptBatcher | undefined {
  return batchers.get(runtime)?.batcher;
}

export function installAssistantPromptBatcher(
  runtime: IAgentRuntime,
): PromptBatcher {
  if (batchers.has(runtime))
    throw new Error("Assistant prompt batcher already installed");
  const settings = resolvePromptBatcherSettings();
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
  batchers.set(runtime, { batcher, worker });
  return batcher;
}

export function disposeAssistantPromptBatcher(runtime: IAgentRuntime): void {
  const owned = batchers.get(runtime);
  if (!owned) return;
  owned.batcher.dispose();
  if (runtime.getTaskWorker(owned.worker.name) === owned.worker) {
    runtime.unregisterTaskWorker(owned.worker.name);
  }
  batchers.delete(runtime);
}
