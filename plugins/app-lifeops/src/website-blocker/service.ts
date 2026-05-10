import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import { logger, Service, stringToUuid } from "@elizaos/core";
import {
  getSelfControlStatus,
  reconcileSelfControlBlockState,
  type SelfControlStatus,
  stopSelfControlBlock,
} from "./engine.js";

export const WEBSITE_BLOCKER_UNBLOCK_TASK_NAME =
  "WEBSITE_BLOCKER_UNBLOCK" as const;
export const WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS = [
  "queue",
  "website-blocker",
  "selfcontrol",
] as const;

const WEBSITE_BLOCKER_UNBLOCK_RETRY_MS = 60_000;

type WebsiteBlockerUnblockDescriptor = {
  kind: "scheduled_unblock";
  version: 1;
  startedAt: string | null;
  endsAt: string;
  websites: string[];
  retryCount: number;
};

type WebsiteBlockerUnblockTaskMetadata = TaskMetadata & {
  websiteBlockerUnblock: WebsiteBlockerUnblockDescriptor;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function haveSameWebsiteSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((website, index) => website === rightSorted[index]);
}

function getWebsiteBlockerTaskRoomId(runtime: IAgentRuntime): UUID {
  return stringToUuid(`website-blocker-unblock-${runtime.agentId}`);
}

function getRetryCount(task: Task): number {
  const descriptor = readWebsiteBlockerTaskDescriptor(task);
  return descriptor?.retryCount ?? 0;
}

function readWebsiteBlockerTaskDescriptor(
  task: Task,
): WebsiteBlockerUnblockDescriptor | null {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const descriptor = metadata?.websiteBlockerUnblock;
  if (!isRecord(descriptor)) {
    return null;
  }

  if (
    descriptor.kind !== "scheduled_unblock" ||
    descriptor.version !== 1 ||
    typeof descriptor.endsAt !== "string" ||
    !Array.isArray(descriptor.websites)
  ) {
    return null;
  }

  const websites = descriptor.websites.filter(
    (website): website is string => typeof website === "string",
  );
  if (websites.length === 0) {
    return null;
  }

  return {
    kind: "scheduled_unblock",
    version: 1,
    startedAt:
      typeof descriptor.startedAt === "string" &&
      descriptor.startedAt.length > 0
        ? descriptor.startedAt
        : null,
    endsAt: descriptor.endsAt,
    websites,
    retryCount:
      typeof descriptor.retryCount === "number" &&
      Number.isFinite(descriptor.retryCount) &&
      descriptor.retryCount >= 0
        ? descriptor.retryCount
        : 0,
  };
}

function isWebsiteBlockerUnblockTask(task: Task): boolean {
  return (
    task.name === WEBSITE_BLOCKER_UNBLOCK_TASK_NAME &&
    readWebsiteBlockerTaskDescriptor(task) !== null
  );
}

function buildWebsiteBlockerTaskMetadata(
  status: SelfControlStatus,
  existing: Record<string, unknown> | null = null,
  retryCount = 0,
): WebsiteBlockerUnblockTaskMetadata {
  if (!status.endsAt) {
    throw new Error("Cannot build a website blocker task without an end time.");
  }

  return {
    ...(existing ?? {}),
    blocking: true,
    websiteBlockerUnblock: {
      kind: "scheduled_unblock",
      version: 1,
      startedAt: status.startedAt,
      endsAt: status.endsAt,
      websites: [...status.websites],
      retryCount,
    },
  };
}

function buildWebsiteBlockerTaskDescription(status: SelfControlStatus): string {
  const websites =
    status.websites.length > 0
      ? status.websites.join(", ")
      : "blocked websites";
  return `Automatically unblock ${websites} at ${status.endsAt ?? "the scheduled end time"}`;
}

function isTaskOwnedByRuntime(
  runtime: IAgentRuntime,
  status: SelfControlStatus,
): boolean {
  return (
    !status.scheduledByAgentId ||
    status.scheduledByAgentId === String(runtime.agentId)
  );
}

function statusMatchesTask(
  status: SelfControlStatus,
  descriptor: WebsiteBlockerUnblockDescriptor,
): boolean {
  if (!status.active || status.endsAt !== descriptor.endsAt) {
    return false;
  }

  if (descriptor.startedAt && status.startedAt !== descriptor.startedAt) {
    return false;
  }

  return haveSameWebsiteSet(status.websites, descriptor.websites);
}

async function waitForTaskStoreReady(
  runtime: IAgentRuntime,
  maxAttempts = 3,
  delayMs = 250,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: ["__website_blocker_ready_probe__"],
      });
      return;
    } catch {
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

async function listWebsiteBlockerUnblockTasks(
  runtime: IAgentRuntime,
): Promise<Task[]> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS],
  });
  return tasks.filter(isWebsiteBlockerUnblockTask);
}

export async function clearWebsiteBlockerExpiryTasks(
  runtime: IAgentRuntime,
): Promise<void> {
  await waitForTaskStoreReady(runtime);
  const tasks = await listWebsiteBlockerUnblockTasks(runtime);
  for (const task of tasks) {
    if (!task.id) {
      continue;
    }
    await runtime.deleteTask(task.id);
  }
}

async function upsertWebsiteBlockerExpiryTask(
  runtime: IAgentRuntime,
  status: SelfControlStatus,
  retryCount = 0,
): Promise<UUID | null> {
  if (
    !status.active ||
    !status.endsAt ||
    !isTaskOwnedByRuntime(runtime, status)
  ) {
    await clearWebsiteBlockerExpiryTasks(runtime);
    return null;
  }

  const dueAtMs = Date.parse(status.endsAt);
  if (!Number.isFinite(dueAtMs)) {
    await clearWebsiteBlockerExpiryTasks(runtime);
    return null;
  }

  await waitForTaskStoreReady(runtime);
  const tasks = await listWebsiteBlockerUnblockTasks(runtime);
  const matchingTask = tasks.find((task) => {
    const descriptor = readWebsiteBlockerTaskDescriptor(task);
    return descriptor ? statusMatchesTask(status, descriptor) : false;
  });

  for (const task of tasks) {
    if (!task.id || task.id === matchingTask?.id) {
      continue;
    }
    await runtime.deleteTask(task.id);
  }

  const metadata = buildWebsiteBlockerTaskMetadata(
    status,
    isRecord(matchingTask?.metadata) ? matchingTask.metadata : null,
    retryCount,
  );
  const description = buildWebsiteBlockerTaskDescription(status);
  const dueAt = Math.max(dueAtMs, Date.now());

  if (matchingTask?.id) {
    await runtime.updateTask(matchingTask.id, {
      description,
      dueAt,
      metadata,
    });
    return matchingTask.id;
  }

  return runtime.createTask({
    name: WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
    description,
    roomId: getWebsiteBlockerTaskRoomId(runtime),
    tags: [...WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS],
    dueAt,
    metadata,
  });
}

export async function syncWebsiteBlockerExpiryTask(
  runtime: IAgentRuntime,
  status: SelfControlStatus | null = null,
): Promise<UUID | null> {
  registerWebsiteBlockerTaskWorker(runtime);
  const nextStatus = status ?? (await reconcileSelfControlBlockState());
  if (
    !nextStatus.active ||
    !nextStatus.endsAt ||
    !isTaskOwnedByRuntime(runtime, nextStatus)
  ) {
    await clearWebsiteBlockerExpiryTasks(runtime);
    return null;
  }

  return upsertWebsiteBlockerExpiryTask(runtime, nextStatus);
}

async function scheduleWebsiteBlockerRetryTask(
  runtime: IAgentRuntime,
  task: Task,
  status: SelfControlStatus,
): Promise<UUID | null> {
  const descriptor = readWebsiteBlockerTaskDescriptor(task);
  if (
    !descriptor ||
    !status.active ||
    !status.endsAt ||
    !statusMatchesTask(status, descriptor)
  ) {
    return null;
  }

  return runtime.createTask({
    name: WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
    description: buildWebsiteBlockerTaskDescription(status),
    roomId: getWebsiteBlockerTaskRoomId(runtime),
    tags: [...WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS],
    dueAt: Date.now() + WEBSITE_BLOCKER_UNBLOCK_RETRY_MS,
    metadata: buildWebsiteBlockerTaskMetadata(
      {
        ...status,
        endsAt: status.endsAt,
      },
      null,
      getRetryCount(task) + 1,
    ),
  });
}

export async function executeWebsiteBlockerExpiryTask(
  runtime: IAgentRuntime,
  task: Task,
): Promise<void> {
  const descriptor = readWebsiteBlockerTaskDescriptor(task);
  if (!descriptor) {
    return;
  }

  const status = await getSelfControlStatus();
  if (!statusMatchesTask(status, descriptor)) {
    return;
  }

  const stopResult = await stopSelfControlBlock();
  if (stopResult.success === true) {
    logger.info(
      `[selfcontrol] Automatically removed the website block scheduled for ${descriptor.endsAt}.`,
    );
    return;
  }

  await scheduleWebsiteBlockerRetryTask(runtime, task, status);
  logger.warn(
    `[selfcontrol] Failed to remove the scheduled website block at ${descriptor.endsAt}; queued a retry in ${WEBSITE_BLOCKER_UNBLOCK_RETRY_MS / 1000}s: ${stopResult.error}`,
  );
}

export function registerWebsiteBlockerTaskWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(WEBSITE_BLOCKER_UNBLOCK_TASK_NAME)) {
    return;
  }

  runtime.registerTaskWorker({
    name: WEBSITE_BLOCKER_UNBLOCK_TASK_NAME,
    shouldRun: async () => true,
    execute: async (rt, _options, task) => {
      await executeWebsiteBlockerExpiryTask(rt, task);
      return undefined;
    },
  });
}

export class SelfControlBlockerService extends Service {
  static serviceType = "selfcontrol_blocker";

  capabilityDescription =
    "Maintains the local hosts-file website blocker and clears timed blocks when they expire.";

  async stop(): Promise<void> {}

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<SelfControlBlockerService> {
    registerWebsiteBlockerTaskWorker(runtime);

    try {
      const status = await reconcileSelfControlBlockState();
      await syncWebsiteBlockerExpiryTask(runtime, status);
    } catch (error) {
      logger.warn(
        `[selfcontrol] Failed to reconcile hosts-file blocker state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return new SelfControlBlockerService(runtime);
  }
}

export class WebsiteBlockerService extends SelfControlBlockerService {
  static override serviceType = "website_blocker";

  override capabilityDescription =
    "Maintains the local hosts-file website blocker and clears timed blocks when they expire.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<WebsiteBlockerService> {
    registerWebsiteBlockerTaskWorker(runtime);

    try {
      const status = await reconcileSelfControlBlockState();
      await syncWebsiteBlockerExpiryTask(runtime, status);
    } catch (error) {
      logger.warn(
        `[selfcontrol] Failed to reconcile hosts-file blocker state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return new WebsiteBlockerService(runtime);
  }
}
