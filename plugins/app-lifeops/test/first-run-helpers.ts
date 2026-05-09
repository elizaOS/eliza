/**
 * Lightweight runtime stub used by the first-run / pending-prompts /
 * global-pause / recent-task-states tests. The heavy `createLifeOpsTestRuntime`
 * harness is overkill for capability-level wave-1 contracts; these tests
 * exercise the store + service surface against the real runtime APIs the
 * production code calls (`getCache` / `setCache` / `deleteCache`).
 *
 * The stub mirrors the contract `IAgentRuntime` exposes for these surfaces
 * exactly. Anything outside the stub's shape would cause a TS error in the
 * production code as soon as the call hits it.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";

export interface MinimalRuntimeStub extends Partial<IAgentRuntime> {
  agentId: UUID;
  getCache: <T>(key: string) => Promise<T | null | undefined>;
  setCache: <T>(key: string, value: T) => Promise<boolean>;
  deleteCache: (key: string) => Promise<boolean>;
  getTasks: (filter?: unknown) => Promise<unknown[]>;
  updateTask: (taskId: string, patch: unknown) => Promise<void>;
  logger?: IAgentRuntime["logger"];
}

const SCHEDULER_TASK_ID = "lifeops-scheduler-task-id" as const;

export function createMinimalRuntimeStub(
  overrides: Partial<MinimalRuntimeStub> = {},
): MinimalRuntimeStub {
  const cache = new Map<string, unknown>();
  const tasks: Array<{
    id: string;
    name: string;
    metadata: Record<string, unknown>;
  }> = [
    {
      id: SCHEDULER_TASK_ID,
      name: "lifeops-scheduler",
      metadata: {
        lifeopsScheduler: { kind: "runtime_runner", version: 1 },
      },
    },
  ];

  const stub: MinimalRuntimeStub = {
    agentId: ("test-agent-" + Math.random().toString(36).slice(2, 8)) as UUID,
    async getCache<T>(key: string): Promise<T | null | undefined> {
      const value = cache.get(key);
      if (value === undefined) return null;
      return value as T;
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
    async getTasks(): Promise<unknown[]> {
      return tasks;
    },
    async updateTask(
      taskId: string,
      patch: { metadata?: Record<string, unknown> },
    ): Promise<void> {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (patch.metadata) {
        task.metadata = { ...task.metadata, ...patch.metadata };
      }
    },
    ...overrides,
  };
  return stub;
}

export const SCHEDULER_TASK_ID_FOR_TESTS = SCHEDULER_TASK_ID;
