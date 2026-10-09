/**
 * Reconciles existing managed dossier records without seeding missing defaults.
 * Exact historical definition fingerprints protect customized work; all proposals
 * are preflighted before canonical conditional writes preserve concurrent edits.
 */
import { ElizaError, stableStringify } from "@elizaos/core";
import type {
  ScheduledTask,
  ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import { z } from "zod";
import {
  DOSSIER_ACTIVITY_ANCHOR_KEY,
  DOSSIER_ACTIVITY_METADATA_KEY,
  type DossierDay,
  dossierOwnerDay,
  isManagedDossierTask,
  readDossierActivityState,
  updateDossierActivityControl,
} from "./dossier-activity-policy.js";

const LEGACY_FIRST_RUN_PROMPT =
  "Render the morning brief at the wake.confirmed anchor.";
const LEGACY_CATALOG_PROMPT =
  "Assemble the owner's morning brief from LifeOps source data: overdue todos, today's meetings, yesterday's wins, tracked habits, inbox/calendar/contacts/promises. Rank for genuinely interesting, important, reply-needed, or schedule-changing items. Keep it concise. No invented facts; if a source is unavailable, say so in one clause. Use the existing morning-checkin assembler — do not regenerate the briefing structure.";

/** Historical prompt equality is a migration fingerprint, never dispatch semantics. */
export function isLegacyManagedDossierDefault(task: ScheduledTask): boolean {
  if (
    (task.metadata?.delegatesAssemblyTo !== undefined &&
      task.metadata.delegatesAssemblyTo !== "lifeops:checkin:morning") ||
    task.completionCheck ||
    task.pipeline ||
    !isManagedDossierTask(task) ||
    task.trigger.kind !== "relative_to_anchor" ||
    stableStringify(task.trigger) !==
      stableStringify({
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 0,
      })
  )
    return false;
  return task.source === "first_run"
    ? task.kind === "watcher" &&
        task.promptInstructions === LEGACY_FIRST_RUN_PROMPT &&
        task.metadata?.firstRunPack === "defaults" &&
        task.metadata?.slot === "morningBrief"
    : task.kind === "recap" &&
        task.promptInstructions === LEGACY_CATALOG_PROMPT &&
        task.metadata?.packKey === "morning-brief" &&
        task.metadata?.recordKey === "morning-brief";
}

function hasActivityAnchor(task: ScheduledTask): boolean {
  return (
    task.trigger.kind === "relative_to_anchor" &&
    task.trigger.anchorKey === DOSSIER_ACTIVITY_ANCHOR_KEY &&
    task.trigger.offsetMinutes === 0
  );
}

const successfulDispatch = z.object({ ok: z.literal(true) }).passthrough();
const rejectedDispatch = z
  .object({ ok: z.literal(false), acceptance: z.literal("not_accepted") })
  .passthrough();

export interface DeferredDossierMigration {
  taskId: string;
  reason: "unresolved_delivery";
}

function propose(
  task: ScheduledTask,
  nowIso: string,
  day: DossierDay,
  deferred: DeferredDossierMigration[],
): ScheduledTask {
  if (!isManagedDossierTask(task)) return task;
  const prior = readDossierActivityState(task.metadata);
  if (!prior) {
    if (hasActivityAnchor(task))
      throw new ElizaError(
        "Managed activity dossier has no persisted control state",
        {
          code: "DOSSIER_ACTIVITY_CONTROL_INVALID",
          context: { taskId: task.taskId },
        },
      );
    if (
      !isLegacyManagedDossierDefault(task) ||
      task.state.status === "dismissed"
    )
      return task;
    const lastDispatch = task.metadata?.lastDispatchResult;
    const settledSuccess = successfulDispatch.safeParse(lastDispatch).success;
    if (
      task.metadata?.pendingDispatch !== undefined ||
      (lastDispatch !== undefined &&
        !settledSuccess &&
        !rejectedDispatch.safeParse(lastDispatch).success) ||
      (["fired", "acknowledged"].includes(task.state.status) && !settledSuccess)
    ) {
      deferred.push({ taskId: task.taskId, reason: "unresolved_delivery" });
      return task;
    }
  } else if (!hasActivityAnchor(task) && task.trigger.kind !== "manual") {
    throw new ElizaError(
      "Persisted dossier control has an unsupported trigger",
      {
        code: "DOSSIER_ACTIVITY_CONTROL_INVALID",
        context: { taskId: task.taskId },
      },
    );
  }
  const next: ScheduledTask = prior
    ? task
    : {
        ...task,
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
          offsetMinutes: 0,
        },
      };
  const state = updateDossierActivityControl({
    previous: task,
    next,
    nowIso,
    day,
  });
  if (!state)
    throw new ElizaError(
      "Managed dossier reconciliation did not produce control state",
      { code: "DOSSIER_ACTIVITY_CONTROL_INVALID" },
    );
  if (prior && stableStringify(prior) === stableStringify(state)) return task;
  if (!prior && task.state.firedAt)
    state.consumedDay = dossierOwnerDay(task.state.firedAt, day);
  return {
    ...next,
    metadata: {
      ...task.metadata,
      ...(!prior ? { delegatesAssemblyTo: "lifeops:checkin:morning" } : {}),
      [DOSSIER_ACTIVITY_METADATA_KEY]: state,
    },
  };
}

/** The caller supplies the server instant and resolved owner day; no independent clock or timezone fallback is used. */
export async function reconcileOwnerDossierActivity(
  store: ScheduledTaskStore,
  options: { nowIso: string; day: DossierDay },
): Promise<{
  tasks: ScheduledTask[];
  changedTaskIds: string[];
  deferred: DeferredDossierMigration[];
}> {
  dossierOwnerDay(options.nowIso, options.day);
  const observed = await store.list();
  const deferred: DeferredDossierMigration[] = [];
  const tasks = observed.map((task) =>
    propose(task, options.nowIso, options.day, deferred),
  );
  const deferredIds = new Set(deferred.map(({ taskId }) => taskId));
  const eligible = tasks.filter(
    (task) =>
      deferredIds.has(task.taskId) ||
      (isManagedDossierTask(task) &&
        hasActivityAnchor(task) &&
        readDossierActivityState(task.metadata)?.enabled &&
        task.state.status !== "dismissed"),
  );
  if (eligible.length > 1)
    throw new ElizaError(
      "Multiple managed dossiers can admit owner activity; reconcile the managed defaults",
      {
        code: "DOSSIER_ACTIVITY_TASK_AMBIGUOUS",
        context: { taskIds: eligible.map((task) => task.taskId) },
      },
    );
  const changedTaskIds: string[] = [];
  for (const [index, task] of tasks.entries()) {
    const previous = observed[index];
    if (task === previous) continue;
    if (!previous)
      throw new ElizaError("Dossier reconciliation lost its observed task", {
        code: "DOSSIER_ACTIVITY_CONTROL_INVALID",
      });
    const committed = await store.upsertIfStatus(task, {
      expectedStatus: previous.state.status,
      expectedState: previous.state,
      expectedMetadata: previous.metadata ?? {},
      expectedDefinition: previous,
      nextFireAtIso: null,
    });
    if (!committed)
      throw new ElizaError(
        "Dossier changed during migration or owner-day reconciliation; retry against the latest task",
        {
          code: "DOSSIER_ACTIVITY_RECONCILIATION_RACED",
          context: { taskId: task.taskId, retryable: true },
        },
      );
    changedTaskIds.push(task.taskId);
  }
  return { tasks, changedTaskIds, deferred };
}
