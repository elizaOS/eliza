/**
 * PendingPromptsService — the runtime-owned store of open scheduled-task
 * prompts, exposed as a registered runtime service.
 *
 * Pending prompts are a runtime primitive: any plugin (LifeOps scheduler, the
 * work-thread evaluator, …) consumes the store via `runtime.getService(...)`
 * rather than constructing the cache-backed store itself. The service is a thin
 * factory over the per-runtime {@link PendingPromptsStore}; the store is
 * cache-backed (no SQL), keyed per room.
 *
 * Mirrors `KnowledgeGraphService` (lifecycle + getService accessor).
 */

import {
  type IAgentRuntime,
  type PendingUserAction,
  Service,
} from "@elizaos/core";
import {
  createPendingPromptsStore,
  type ExpectedReplyKind,
  type PendingPromptsStore,
} from "./store.ts";

export const PENDING_PROMPTS_SERVICE = "eliza_pending_prompts";

export class PendingPromptsService extends Service {
  static override serviceType = PENDING_PROMPTS_SERVICE;

  override capabilityDescription =
    "Runtime pending-prompts store: open scheduled-task prompts per room, cache-backed";

  static async start(runtime: IAgentRuntime): Promise<PendingPromptsService> {
    return new PendingPromptsService(runtime);
  }

  async stop(): Promise<void> {}

  /** The cache-backed pending-prompts store for this runtime. */
  getStore(): PendingPromptsStore {
    return createPendingPromptsStore(this.runtime);
  }

  /**
   * Canonical "agent is waiting on you" projection for all open prompts.
   * UI/provider surfaces should consume this instead of reshaping store records.
   */
  async listPendingUserActions(): Promise<PendingUserAction[]> {
    const prompts = await this.getStore().listAll();
    return prompts.map((prompt) => ({
      id: prompt.taskId,
      kind: "pending_prompt",
      source: "pending-prompts",
      title: prompt.promptSnippet,
      roomId: prompt.roomId,
      expectedReplyKind: prompt.expectedReplyKind,
      weight: promptWeight(prompt.expectedReplyKind),
      resolution: {
        target: "pending_prompt",
        requestId: prompt.taskId,
      },
      data: {
        expectedReplyKind: prompt.expectedReplyKind,
      },
      createdAt: Date.parse(prompt.firedAt),
      expiresAt:
        prompt.expiresAt && Number.isFinite(Date.parse(prompt.expiresAt))
          ? Date.parse(prompt.expiresAt)
          : null,
    }));
  }
}

function promptWeight(kind: ExpectedReplyKind): number {
  if (kind === "approval") return 9;
  if (kind === "yes_no") return 7;
  return 6;
}

/**
 * Resolve the registered {@link PendingPromptsService}. Returns `null` when the
 * runtime has not registered it (e.g. the "eliza" plugin is absent).
 */
export function resolvePendingPromptsService(
  runtime: IAgentRuntime,
): PendingPromptsService | null {
  return runtime.getService<PendingPromptsService>(PENDING_PROMPTS_SERVICE);
}
