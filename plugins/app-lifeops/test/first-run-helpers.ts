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

import type {
  Agent,
  Character,
  IAgentRuntime,
  Task,
  UUID,
} from "@elizaos/core";

export interface MinimalRuntimeStub extends Partial<IAgentRuntime> {
  agentId: UUID;
  getCache: <T>(key: string) => Promise<T | null | undefined>;
  setCache: <T>(key: string, value: T) => Promise<boolean>;
  deleteCache: (key: string) => Promise<boolean>;
  getTasks: (filter?: unknown) => Promise<unknown[]>;
  createTask: (task: Task) => Promise<UUID>;
  updateTask: (taskId: string, patch: unknown) => Promise<void>;
  getAgent: (agentId: UUID) => Promise<Agent | null>;
  createAgent: (agent: Partial<Agent>) => Promise<boolean>;
  getService: (serviceType: string) => unknown | null;
  character: Character;
  logger?: IAgentRuntime["logger"];
}

const SCHEDULER_TASK_ID = "lifeops-scheduler-task-id" as const;

export function createMinimalRuntimeStub(
  overrides: Partial<MinimalRuntimeStub> = {},
): IAgentRuntime {
  const cache = new Map<string, unknown>();
  const agentId = ("test-agent-" +
    Math.random().toString(36).slice(2, 8)) as UUID;
  let agentRecord: Agent | null = null;
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
    agentId,
    character: {
      id: agentId,
      name: "FirstRunTestAgent",
      bio: "Minimal first-run test agent.",
    },
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
    async createTask(task: Task): Promise<UUID> {
      const id =
        task.id ??
        (("task-" + Math.random().toString(36).slice(2, 10)) as UUID);
      tasks.push({
        id,
        name: task.name,
        metadata:
          task.metadata && typeof task.metadata === "object"
            ? { ...(task.metadata as Record<string, unknown>) }
            : {},
      });
      return id;
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
    async getAgent(requestedAgentId: UUID): Promise<Agent | null> {
      if (requestedAgentId !== agentId) return null;
      return agentRecord;
    },
    async createAgent(agent: Partial<Agent>): Promise<boolean> {
      agentRecord = {
        ...stub.character,
        ...agent,
        id: (agent.id ?? agentId) as UUID,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Agent;
      return true;
    },
    getService(): unknown | null {
      return null;
    },
    ...overrides,
  };
  return stub as IAgentRuntime;
}

export const SCHEDULER_TASK_ID_FOR_TESTS = SCHEDULER_TASK_ID;
