/**
 * One-time migration (#12177 WI-3): fold the legacy `schedule:<cron>` /
 * `event:<name>` **tag** encoding on workbench tasks into a strict
 * `TriggerConfig` on `metadata.trigger` (kind `"prompt"`), retagging the row as
 * a `TRIGGER_DISPATCH` task so the one trigger clock fires it.
 *
 * The tag encoding was the third (and outlier) schedule representation in the
 * repo; after this migration exactly two remain: `TriggerConfig` (engine side)
 * and the LifeOps `trigger` union (scheduled items). A "run this prompt every
 * morning" workbench task *is* a trigger whose target is a prompt.
 *
 * Idempotent: a task already carrying `metadata.trigger` (already a trigger) is
 * skipped, and the schedule tags are removed as part of the rewrite so a second
 * pass finds nothing to do.
 */

import crypto from "node:crypto";
import type { IAgentRuntime, Task, TriggerType, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { WORKBENCH_TASK_TAG } from "../api/workbench-helpers.ts";
import {
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
} from "./runtime.ts";
import { buildTriggerConfig, buildTriggerMetadata } from "./scheduling.ts";
import type { NormalizedTriggerDraft } from "./types.ts";

const SCHEDULE_TAG_PREFIX = "schedule:";
const EVENT_TAG_PREFIX = "event:";

interface DecodedScheduleTag {
  triggerType: Extract<TriggerType, "cron" | "event">;
  cronExpression?: string;
  eventKind?: string;
}

/** Read a `schedule:<cron>` / `event:<name>` tag off a task, if present. */
export function decodeScheduleTag(
  tags: readonly string[] | undefined,
): DecodedScheduleTag | null {
  for (const tag of tags ?? []) {
    if (tag.startsWith(SCHEDULE_TAG_PREFIX)) {
      const cronExpression = tag.slice(SCHEDULE_TAG_PREFIX.length).trim();
      if (cronExpression) return { triggerType: "cron", cronExpression };
    }
    if (tag.startsWith(EVENT_TAG_PREFIX)) {
      const eventKind = tag.slice(EVENT_TAG_PREFIX.length).trim();
      if (eventKind) return { triggerType: "event", eventKind };
    }
  }
  return null;
}

function stripScheduleTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter(
    (tag) =>
      !tag.startsWith(SCHEDULE_TAG_PREFIX) && !tag.startsWith(EVENT_TAG_PREFIX),
  );
}

/**
 * Migrate a single task in place if it carries a legacy schedule tag and is not
 * already a trigger. Returns the id it rewrote, or null if it skipped the task.
 */
async function migrateWorkbenchScheduleTask(
  runtime: IAgentRuntime,
  task: Task,
): Promise<UUID | null> {
  if (!task.id) return null;
  // Already a trigger (has metadata.trigger) — nothing to do.
  if (readTriggerConfig(task)) return null;

  const decoded = decodeScheduleTag(task.tags);
  if (!decoded) return null;

  const instructions =
    (typeof task.description === "string" && task.description.trim()) ||
    (typeof task.name === "string" && task.name.trim()) ||
    "Run prompt automation";
  const displayName =
    (typeof task.name === "string" && task.name.trim()) || "Prompt automation";

  const draft: NormalizedTriggerDraft = {
    displayName,
    instructions,
    triggerType: decoded.triggerType,
    wakeMode: "inject_now",
    enabled: true,
    createdBy: "workbench.migration",
    cronExpression: decoded.cronExpression,
    eventKind: decoded.eventKind,
    kind: "prompt",
  };

  const triggerId = stringToUuid(crypto.randomUUID());
  const trigger = buildTriggerConfig({ draft, triggerId });
  const metadata = buildTriggerMetadata({ trigger, nowMs: Date.now() });
  if (!metadata) return null;

  const nextTags = new Set(stripScheduleTags(task.tags));
  for (const tag of TRIGGER_TASK_TAGS) nextTags.add(tag);
  nextTags.delete(WORKBENCH_TASK_TAG);

  await runtime.updateTask(task.id, {
    name: TRIGGER_TASK_NAME,
    description: displayName,
    tags: [...nextTags],
    metadata: metadata as Task["metadata"],
  });
  return task.id;
}

/**
 * Sweep every workbench task on this agent and migrate any that still encode a
 * schedule in tags. Safe to run on every boot (idempotent). Returns the count
 * migrated.
 */
export async function migrateWorkbenchScheduleTags(
  runtime: IAgentRuntime,
): Promise<number> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [WORKBENCH_TASK_TAG],
  });
  let migrated = 0;
  for (const task of tasks) {
    const id = await migrateWorkbenchScheduleTask(runtime, task);
    if (id) migrated += 1;
  }
  if (migrated > 0) {
    runtime.logger.info(
      { src: "trigger-runtime", migrated },
      `Migrated ${migrated} tag-encoded workbench schedule(s) to metadata.trigger`,
    );
  }
  return migrated;
}
