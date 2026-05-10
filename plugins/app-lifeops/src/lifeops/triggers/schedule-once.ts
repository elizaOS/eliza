import crypto from "node:crypto";
import {
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "@elizaos/agent";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  normalizeTriggerDraft,
} from "@elizaos/agent";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";

type ScheduledTriggerTaskResult = {
  duplicateTaskId?: UUID;
  taskId?: UUID;
  triggerId?: UUID;
  summary?: ReturnType<typeof taskToTriggerSummary>;
};

type ScheduleOnceTriggerArgs = {
  runtime: IAgentRuntime;
  message: Memory;
  displayName: string;
  instructions: string;
  scheduledAtIso: string;
  dedupeKey?: string;
};

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

export async function scheduleOnceTriggerTask(
  args: ScheduleOnceTriggerArgs,
): Promise<ScheduledTriggerTaskResult> {
  if (!triggersFeatureEnabled(args.runtime)) {
    throw new Error("Triggers are disabled by configuration.");
  }

  const creator = String(args.message.entityId ?? args.runtime.agentId);
  const normalized = normalizeTriggerDraft({
    input: {
      displayName: args.displayName,
      instructions: args.instructions,
      triggerType: "once",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: creator,
      scheduledAtIso: args.scheduledAtIso,
      kind: "text",
      maxRuns: 1,
    },
    fallback: {
      displayName: args.displayName,
      instructions: args.instructions,
      triggerType: "once",
      wakeMode: "inject_now",
      enabled: true,
      createdBy: creator,
    },
  });

  if (!normalized.draft) {
    throw new Error(normalized.error ?? "Invalid trigger request.");
  }

  const activeTasks = await listTriggerTasks(args.runtime);
  const limit = getTriggerLimit(args.runtime);
  const activeCreatorCount = activeTasks.filter((task) => {
    const trigger = readTriggerConfig(task);
    return trigger?.enabled && trigger.createdBy === creator;
  }).length;

  if (activeCreatorCount >= limit) {
    throw new Error(`Trigger limit reached (${limit} active triggers).`);
  }

  const triggerId = stringToUuid(crypto.randomUUID()) as UUID;
  const triggerConfig = buildTriggerConfig({
    draft: normalized.draft,
    triggerId,
  });
  if (args.dedupeKey) {
    triggerConfig.dedupeKey = args.dedupeKey;
  }

  const duplicate = activeTasks.find((task) => {
    const existing = readTriggerConfig(task);
    return existing?.enabled && existing.dedupeKey === triggerConfig.dedupeKey;
  });
  if (duplicate?.id) {
    return {
      duplicateTaskId: duplicate.id,
      summary: taskToTriggerSummary(duplicate),
    };
  }

  const metadata = buildTriggerMetadata({
    trigger: triggerConfig,
    nowMs: Date.now(),
  });
  if (!metadata) {
    throw new Error("Unable to compute trigger schedule.");
  }

  const autonomy = args.runtime.getService?.(
    "AUTONOMY",
  ) as AutonomyServiceLike | null;
  const roomId = autonomy?.getAutonomousRoomId?.() ?? args.message.roomId;

  const taskId = await args.runtime.createTask({
    name: TRIGGER_TASK_NAME,
    description: triggerConfig.displayName,
    roomId,
    tags: [...TRIGGER_TASK_TAGS],
    metadata,
  });
  const task = await args.runtime.getTask(taskId);

  return {
    taskId,
    triggerId,
    summary: task ? taskToTriggerSummary(task) : null,
  };
}
