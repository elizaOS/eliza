/**
 * GoalsCheckinService — per-goal check-in engine on the scheduling spine.
 *
 * Goal check-ins are plain `ScheduledTask` records (`kind: "checkin"`) on
 * `@elizaos/plugin-scheduling`'s runner, created idempotently per goal +
 * cadence slot and fired by the production tick/dispatcher like every other
 * scheduled task. This service owns three seams:
 *
 *  - `syncGoalCheckins(goal)` — reconcile the goal's check-in tasks with its
 *    current status + cadence (create missing slots, edit changed triggers,
 *    dismiss slots the cadence no longer declares). Called by `GoalsService`
 *    after every goal write via the `checkinSync` hook, and once per goal at
 *    boot.
 *  - `removeGoalCheckins(goalId)` — dismiss all live check-in tasks for a
 *    deleted goal.
 *  - `recordCheckinResponse(args)` — route an owner check-in response into
 *    goal progress: complete the fired task, append a bounded
 *    `metadata.checkinLog` entry, set `reviewState` from the reported
 *    progress, and write a `goal_updated` audit event.
 *
 * Cron slots use the `owner_local` tz sentinel so check-ins fire at the
 * owner's local hour wherever they are (resolved by the spine against
 * owner facts).
 *
 * Deliberate non-features: a slot the owner dismissed is never resurrected
 * for the same trigger shape (spine seed semantics); a goal with no cadence
 * (or an unusable one) schedules no check-ins — that is logged, not padded
 * with invented defaults.
 */

import crypto from "node:crypto";
import type {
  LifeOpsGoalDefinition,
  LifeOpsGoalReviewState,
} from "@elizaos/contracts";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  OWNER_LOCAL_TZ,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRunnerHandle,
  ScheduledTaskRunnerService,
  type ScheduledTaskStatus,
  type ScheduledTaskTrigger,
  type TerminalState,
} from "@elizaos/plugin-scheduling";
import { GoalsRepository } from "../db/goals-repository.ts";
import { fail, requireAgentId } from "../goal-normalize.ts";
import type { GoalsCheckinSync } from "../goals-service.ts";
import { GOALS_CHECKIN_SERVICE_TYPE, GOALS_LOG_PREFIX } from "../types.ts";

/** `createdBy` stamp identifying check-in tasks this engine owns. */
export const GOAL_CHECKIN_CREATED_BY = "@elizaos/plugin-goals";

/** Dismissal reason recorded when a cadence change retires a slot. */
export const GOAL_CHECKIN_SYNC_DISMISS_REASON = "goal_checkin_sync";
/** Reason recorded when sync reopens a once check-in it had dismissed. */
export const GOAL_CHECKIN_SYNC_REOPEN_REASON = "goal_checkin_sync_reopen";

/** Bounded length of the per-goal `metadata.checkinLog` history. */
export const GOAL_CHECKIN_LOG_LIMIT = 50;

/** Progress states an owner check-in response may assign to a goal. */
export const GOAL_CHECKIN_PROGRESS_STATES = [
  "on_track",
  "at_risk",
  "needs_attention",
] as const satisfies readonly LifeOpsGoalReviewState[];
export type GoalCheckinProgress = (typeof GOAL_CHECKIN_PROGRESS_STATES)[number];

const TERMINAL_TASK_STATUSES: ReadonlySet<ScheduledTaskStatus> =
  new Set<TerminalState>([
    "completed",
    "skipped",
    "expired",
    "failed",
    "dismissed",
  ]);

/**
 * Representative owner-local hour for each named LifeOps time window.
 * `custom` windows carry per-definition minutes the goal cadence does not,
 * so they cannot be mapped here and are skipped with a warning.
 */
const WINDOW_HOURS: Readonly<Record<string, number>> = {
  morning: 9,
  afternoon: 15,
  evening: 18,
  night: 21,
};

export interface GoalCheckinPlan {
  /** Stable slot identity within the goal (part of the idempotency key). */
  slotKey: string;
  trigger: ScheduledTaskTrigger;
}

export function checkinIdempotencyKey(goalId: string, slotKey: string): string {
  return `goals:checkin:${goalId}:${slotKey}`;
}

// A recurring slot the sync retired (goal paused, cadence moved away) keeps its
// dismissed row and that row's idempotency key, so reviving the slot schedules
// a successor under `<slot key>:resumed:<n>`; the highest generation is the
// slot's current task.
const RESUMED_KEY_SEPARATOR = ":resumed:";

/** Every check-in input carries its slot key (see buildCheckinTaskInput). */
function requireSlotKey(input: ScheduledTaskInput): string {
  if (!input.idempotencyKey) {
    throw new Error("Goal check-in task input has no idempotency key");
  }
  return input.idempotencyKey;
}

function slotKeyGeneration(
  taskKey: string | undefined,
  slotKey: string,
): number | null {
  if (taskKey === slotKey) return 0;
  if (!taskKey?.startsWith(`${slotKey}${RESUMED_KEY_SEPARATOR}`)) return null;
  const generation = Number(
    taskKey.slice(slotKey.length + RESUMED_KEY_SEPARATOR.length),
  );
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function warnCadence(goalId: string, detail: string): void {
  logger.warn(
    `${GOALS_LOG_PREFIX} [GoalsCheckinService] goal ${goalId}: ${detail} — no check-in scheduled for it`,
  );
}

function windowHoursOf(windows: unknown, goalId: string): number[] {
  if (!Array.isArray(windows)) {
    warnCadence(goalId, "cadence.windows is not an array");
    return [];
  }
  const hours = new Set<number>();
  for (const window of windows) {
    const hour = typeof window === "string" ? WINDOW_HOURS[window] : undefined;
    if (hour === undefined) {
      warnCadence(
        goalId,
        `unsupported cadence window ${JSON.stringify(window)}`,
      );
      continue;
    }
    hours.add(hour);
  }
  return [...hours].sort((a, b) => a - b);
}

function cronWeekdaysOf(weekdays: unknown, goalId: string): number[] {
  if (!Array.isArray(weekdays)) {
    warnCadence(goalId, "cadence.weekdays is not an array");
    return [];
  }
  const days = new Set<number>();
  for (const day of weekdays) {
    if (
      typeof day === "number" &&
      Number.isInteger(day) &&
      day >= 0 &&
      day <= 6
    ) {
      days.add(day);
    } else {
      warnCadence(goalId, `unsupported cadence weekday ${JSON.stringify(day)}`);
    }
  }
  return [...days].sort((a, b) => a - b);
}

function ownerLocalCron(expression: string): ScheduledTaskTrigger {
  return { kind: "cron", expression, tz: OWNER_LOCAL_TZ };
}

/**
 * Map a goal's cadence (`LifeOpsCadence`-shaped `Record`) to concrete
 * check-in trigger slots. Pure; validated field-by-field because
 * `LifeOpsGoalDefinition.cadence` is persisted as an untyped record.
 * Unusable cadences yield `[]` and a warning — never an invented default.
 */
export function checkinTriggersForGoal(
  goal: LifeOpsGoalDefinition,
): GoalCheckinPlan[] {
  const cadence = goal.cadence;
  if (!cadence) return [];
  const kind = cadence.kind;
  switch (kind) {
    case "once": {
      const dueAt = cadence.dueAt;
      if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt))) {
        warnCadence(goal.id, "once cadence has no parseable dueAt");
        return [];
      }
      // Keyed by instant: moving the date needs a new task, because a once
      // task that has already fired can't be re-armed by an edit.
      const atIso = new Date(dueAt).toISOString();
      return [{ slotKey: `once:${atIso}`, trigger: { kind: "once", atIso } }];
    }
    case "daily": {
      const hours = windowHoursOf(cadence.windows, goal.id);
      if (hours.length === 0) return [];
      return [
        {
          slotKey: "daily",
          trigger: ownerLocalCron(`0 ${hours.join(",")} * * *`),
        },
      ];
    }
    case "weekly": {
      const hours = windowHoursOf(cadence.windows, goal.id);
      const days = cronWeekdaysOf(cadence.weekdays, goal.id);
      if (hours.length === 0 || days.length === 0) return [];
      return [
        {
          slotKey: "weekly",
          trigger: ownerLocalCron(`0 ${hours.join(",")} * * ${days.join(",")}`),
        },
      ];
    }
    case "interval": {
      const everyMinutes = cadence.everyMinutes;
      if (
        typeof everyMinutes !== "number" ||
        !Number.isInteger(everyMinutes) ||
        everyMinutes <= 0
      ) {
        warnCadence(goal.id, "interval cadence has no positive everyMinutes");
        return [];
      }
      return [
        { slotKey: "interval", trigger: { kind: "interval", everyMinutes } },
      ];
    }
    case "times_per_day": {
      const slots = cadence.slots;
      if (!Array.isArray(slots) || slots.length === 0) {
        warnCadence(goal.id, "times_per_day cadence has no slots");
        return [];
      }
      const plans: GoalCheckinPlan[] = [];
      for (const slot of slots) {
        const record =
          slot && typeof slot === "object" && !Array.isArray(slot)
            ? (slot as Record<string, unknown>)
            : null;
        const key = record?.key;
        const minuteOfDay = record?.minuteOfDay;
        if (
          typeof key !== "string" ||
          key.length === 0 ||
          typeof minuteOfDay !== "number" ||
          !Number.isInteger(minuteOfDay) ||
          minuteOfDay < 0 ||
          minuteOfDay >= 24 * 60
        ) {
          warnCadence(
            goal.id,
            `unsupported times_per_day slot ${JSON.stringify(slot)}`,
          );
          continue;
        }
        const hour = Math.floor(minuteOfDay / 60);
        const minute = minuteOfDay % 60;
        plans.push({
          slotKey: `slot-${key}`,
          trigger: ownerLocalCron(`${minute} ${hour} * * *`),
        });
      }
      return plans;
    }
    default:
      warnCadence(goal.id, `unsupported cadence kind ${JSON.stringify(kind)}`);
      return [];
  }
}

/**
 * Build the spine task input for one goal check-in slot. `nowIso` becomes
 * `metadata.createdAtIso` — the cron due-scan base — so a fresh check-in
 * never "catches up" an occurrence from before the slot existed.
 */
export function buildCheckinTaskInput(
  goal: LifeOpsGoalDefinition,
  plan: GoalCheckinPlan,
  nowIso: string,
): ScheduledTaskInput {
  return {
    kind: "checkin",
    promptInstructions: `Run a goal check-in for "${goal.title}": ask the owner how progress toward this goal is going, listen for wins and blockers, and record their response against the goal.`,
    trigger: plan.trigger,
    priority: "medium",
    respectsGlobalPause: true,
    completionCheck: {
      kind: "user_replied_within",
      params: { lookbackMinutes: 60 },
      followupAfterMinutes: 30,
    },
    contextRequest: {
      includeOwnerFacts: ["preferredName", "timezone"],
      includeRecentTaskStates: { kind: "checkin", lookbackHours: 48 },
    },
    idempotencyKey: checkinIdempotencyKey(goal.id, plan.slotKey),
    source: "plugin",
    createdBy: GOAL_CHECKIN_CREATED_BY,
    ownerVisible: true,
    metadata: {
      goalId: goal.id,
      goalTitle: goal.title,
      slotKey: plan.slotKey,
      createdAtIso: nowIso,
    },
  };
}

export interface GoalCheckinSyncResult {
  scheduled: ScheduledTask[];
  edited: ScheduledTask[];
  dismissedTaskIds: string[];
}

export interface RecordGoalCheckinArgs {
  goalId: string;
  /** Specific fired task to complete; defaults to the latest fired one. */
  taskId?: string;
  note?: string;
  progress?: GoalCheckinProgress;
}

export interface GoalCheckinLogEntry {
  atIso: string;
  taskId: string | null;
  note: string | null;
  progress: GoalCheckinProgress | null;
}

function readCheckinLog(
  metadata: Record<string, unknown>,
): GoalCheckinLogEntry[] {
  const raw = metadata.checkinLog;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is GoalCheckinLogEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return typeof (entry as Record<string, unknown>).atIso === "string";
  });
}

export class GoalsCheckinService extends Service implements GoalsCheckinSync {
  static override readonly serviceType = GOALS_CHECKIN_SERVICE_TYPE;

  override capabilityDescription =
    "Per-goal check-in engine on the scheduling spine: creates cadence-driven checkin tasks per goal, dismisses them when goals close, and records check-in responses into goal progress.";

  private repositoryInstance: GoalsRepository | null = null;
  private warnedSpineMissing = false;
  private stopping = false;
  private releaseStop!: () => void;
  private readonly stopRequested = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });
  private reconciliation?: Promise<void>;
  private readonly now: () => Date;

  constructor(runtime?: IAgentRuntime, now: () => Date = () => new Date()) {
    super(runtime);
    this.now = now;
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<GoalsCheckinService> {
    logger.info(`${GOALS_LOG_PREFIX} starting GoalsCheckinService`);
    const service = new GoalsCheckinService(runtime);
    service.reconciliation = service.reconcileWhenReady();
    return service;
  }

  override async stop(): Promise<void> {
    logger.info(`${GOALS_LOG_PREFIX} stopping GoalsCheckinService`);
    this.stopping = true;
    this.releaseStop();
    await this.reconciliation;
  }

  private rt(): IAgentRuntime {
    if (!this.runtime) {
      throw new Error(
        "GoalsCheckinService: runtime is not bound; was the service started?",
      );
    }
    return this.runtime;
  }

  private repository(): GoalsRepository {
    if (!this.repositoryInstance) {
      this.repositoryInstance = new GoalsRepository(this.rt());
    }
    return this.repositoryInstance;
  }

  private runner(): ScheduledTaskRunnerHandle {
    const runtime = this.rt();
    return getScheduledTaskRunner(runtime, {
      agentId: requireAgentId(runtime),
    });
  }

  /**
   * The spine is a declared plugin dependency, so in production this is
   * always true. Test/minimal runtimes without `@elizaos/plugin-scheduling`
   * get goal CRUD without scheduled check-ins — warned once, not silent.
   */
  private spineAvailable(): boolean {
    if (this.rt().hasService(ScheduledTaskRunnerService.serviceType)) {
      return true;
    }
    if (!this.warnedSpineMissing) {
      this.warnedSpineMissing = true;
      logger.warn(
        `${GOALS_LOG_PREFIX} [GoalsCheckinService] scheduling spine not registered on this runtime; goal check-ins are NOT scheduled`,
      );
    }
    return false;
  }

  private async listGoalTasks(
    runner: ScheduledTaskRunnerHandle,
    goalId: string,
  ): Promise<ScheduledTask[]> {
    const tasks = await runner.list({ kind: "checkin" });
    return tasks.filter(
      (task) =>
        task.createdBy === GOAL_CHECKIN_CREATED_BY &&
        task.metadata?.goalId === goalId,
    );
  }

  /**
   * Reconcile one goal's check-in tasks with its current status + cadence.
   * Idempotent: unchanged slots are left untouched (spine idempotency-key
   * dedupe), changed triggers are edited in place, retired slots are
   * dismissed, and a slot the owner already dismissed stays dismissed.
   */
  async syncGoalCheckins(
    goal: LifeOpsGoalDefinition,
  ): Promise<GoalCheckinSyncResult> {
    if (!this.spineAvailable()) {
      return { scheduled: [], edited: [], dismissedTaskIds: [] };
    }
    const runner = this.runner();
    const nowIso = this.now().toISOString();
    const plans = goal.status === "active" ? checkinTriggersForGoal(goal) : [];
    const desired = plans.map((plan) =>
      buildCheckinTaskInput(goal, plan, nowIso),
    );
    const existing = await this.listGoalTasks(runner, goal.id);
    // A task already holding a desired once instant covers it under any key
    // (including the older unkeyed `once` slot): live, it is kept; finished,
    // that check-in already ran; dismissed, the owner turned it off.
    const desiredOnceTriggers = new Set(
      desired
        .filter((input) => input.trigger.kind === "once")
        .map((input) =>
          input.trigger.kind === "once" ? Date.parse(input.trigger.atIso) : NaN,
        ),
    );
    const holdsDesiredOnce = (task: ScheduledTask): boolean =>
      task.trigger.kind === "once" &&
      desiredOnceTriggers.has(Date.parse(task.trigger.atIso));
    // Only a never-fired task retired by sync may be revived. Sync also
    // dismisses fired tasks when their date moves; those still cover the
    // delivered instant, including legacy keys, and must not dispatch again.
    const syncDismissedPending = (task: ScheduledTask): boolean =>
      task.state.status === "dismissed" &&
      task.state.lastDecisionLog === GOAL_CHECKIN_SYNC_DISMISS_REASON &&
      task.state.firedAt == null &&
      task.state.completedAt == null;

    const belongsToDesiredSlot = (task: ScheduledTask): boolean =>
      desired.some(
        (input) =>
          slotKeyGeneration(task.idempotencyKey, requireSlotKey(input)) !==
          null,
      );

    const dismissedTaskIds: string[] = [];
    for (const task of existing) {
      if (belongsToDesiredSlot(task)) continue;
      if (holdsDesiredOnce(task)) continue;
      if (TERMINAL_TASK_STATUSES.has(task.state.status)) continue;
      await runner.apply(task.taskId, "dismiss", {
        reason: GOAL_CHECKIN_SYNC_DISMISS_REASON,
      });
      dismissedTaskIds.push(task.taskId);
    }

    const scheduled: ScheduledTask[] = [];
    const edited: ScheduledTask[] = [];
    for (const input of desired) {
      let current: ScheduledTask | undefined;
      let currentGeneration = -1;
      for (const task of existing) {
        const generation = slotKeyGeneration(
          task.idempotencyKey,
          requireSlotKey(input),
        );
        if (generation !== null && generation > currentGeneration) {
          current = task;
          currentGeneration = generation;
        }
      }
      if (!current) {
        const covered =
          input.trigger.kind === "once" &&
          existing.some(
            (task) =>
              task.trigger.kind === "once" &&
              input.trigger.kind === "once" &&
              Date.parse(task.trigger.atIso) ===
                Date.parse(input.trigger.atIso) &&
              !syncDismissedPending(task),
          );
        if (!covered) scheduled.push(await runner.schedule(input));
        continue;
      }
      if (current.state.status === "dismissed") {
        // An owner dismissal is a deliberate off-switch and is never undone.
        // A once task the sync dismissed while pending (the date moved away)
        // never fired, so moving the date back reopens it: its key stays
        // reserved and no replacement task could be scheduled under it.
        if (input.trigger.kind === "once" && syncDismissedPending(current)) {
          scheduled.push(
            await runner.apply(current.taskId, "reopen", {
              reason: GOAL_CHECKIN_SYNC_REOPEN_REASON,
            }),
          );
        } else if (
          input.trigger.kind !== "once" &&
          current.state.lastDecisionLog === GOAL_CHECKIN_SYNC_DISMISS_REASON
        ) {
          // A recurring slot can't be reopened (it may have fired days ago,
          // and a reopen would fire that stale occurrence at once): schedule
          // its successor from now instead.
          scheduled.push(
            await runner.schedule({
              ...input,
              idempotencyKey: `${input.idempotencyKey}${RESUMED_KEY_SEPARATOR}${currentGeneration + 1}`,
            }),
          );
        }
        continue;
      }
      const triggerChanged =
        current.trigger.kind === "once" && input.trigger.kind === "once"
          ? Date.parse(current.trigger.atIso) !==
            Date.parse(input.trigger.atIso)
          : JSON.stringify(current.trigger) !== JSON.stringify(input.trigger);
      const titleChanged = current.metadata?.goalTitle !== goal.title;
      if (triggerChanged || titleChanged) {
        edited.push(
          await runner.apply(current.taskId, "edit", {
            trigger: input.trigger,
            promptInstructions: input.promptInstructions,
            metadata: { ...current.metadata, goalTitle: goal.title },
          }),
        );
      }
    }

    if (
      scheduled.length > 0 ||
      edited.length > 0 ||
      dismissedTaskIds.length > 0
    ) {
      logger.info(
        `${GOALS_LOG_PREFIX} [GoalsCheckinService] synced check-ins for goal ${goal.id}: ${scheduled.length} scheduled, ${edited.length} edited, ${dismissedTaskIds.length} dismissed`,
      );
    }
    return { scheduled, edited, dismissedTaskIds };
  }

  /** Dismiss all live check-in tasks for a deleted goal. */
  async removeGoalCheckins(
    goalId: string,
  ): Promise<{ dismissedTaskIds: string[] }> {
    if (!this.spineAvailable()) {
      return { dismissedTaskIds: [] };
    }
    const runner = this.runner();
    const existing = await this.listGoalTasks(runner, goalId);
    const dismissedTaskIds: string[] = [];
    for (const task of existing) {
      if (TERMINAL_TASK_STATUSES.has(task.state.status)) continue;
      await runner.apply(task.taskId, "dismiss", {
        reason: GOAL_CHECKIN_SYNC_DISMISS_REASON,
      });
      dismissedTaskIds.push(task.taskId);
    }
    if (dismissedTaskIds.length > 0) {
      logger.info(
        `${GOALS_LOG_PREFIX} [GoalsCheckinService] dismissed ${dismissedTaskIds.length} check-in task(s) for deleted goal ${goalId}`,
      );
    }
    return { dismissedTaskIds };
  }

  /**
   * Route an owner check-in response into goal progress: complete the fired
   * check-in task (when one is live), append a bounded `checkinLog` entry to
   * the goal's metadata, set `reviewState` from the reported progress, and
   * write a `goal_updated` audit event.
   */
  async recordCheckinResponse(
    args: RecordGoalCheckinArgs,
  ): Promise<{ goal: LifeOpsGoalDefinition; completedTaskId: string | null }> {
    const runtime = this.rt();
    const agentId = requireAgentId(runtime);
    const goal = await this.repository().getGoal(agentId, args.goalId);
    if (!goal) {
      fail(404, "life-ops goal not found");
    }

    const spine = this.spineAvailable();
    const tasks = spine ? await this.listGoalTasks(this.runner(), goal.id) : [];
    let target: ScheduledTask | undefined;
    if (args.taskId) {
      target = tasks.find((task) => task.taskId === args.taskId);
      if (!target) {
        fail(404, `check-in task ${args.taskId} not found for goal`);
      }
    } else {
      target = tasks
        .filter(
          (task) =>
            task.state.status === "fired" ||
            task.state.status === "acknowledged",
        )
        .sort(
          (a, b) =>
            Date.parse(b.state.firedAt ?? "") -
            Date.parse(a.state.firedAt ?? ""),
        )[0];
    }

    let completedTaskId: string | null = null;
    if (
      target &&
      (target.state.status === "fired" ||
        target.state.status === "acknowledged")
    ) {
      await this.runner().apply(target.taskId, "complete", {
        note: args.note ?? null,
        progress: args.progress ?? null,
      });
      completedTaskId = target.taskId;
    }

    const atIso = this.now().toISOString();
    const entry: GoalCheckinLogEntry = {
      atIso,
      taskId: completedTaskId,
      note: args.note ?? null,
      progress: args.progress ?? null,
    };
    // Completing the task above is async; build on the goal as stored now and
    // write only the check-in's own fields, so an edit or review made in the
    // meantime is not reverted by the earlier read.
    const current = await this.repository().getGoal(agentId, goal.id);
    if (!current) {
      fail(404, "life-ops goal not found");
    }
    const checkinLog = [...readCheckinLog(current.metadata), entry].slice(
      -GOAL_CHECKIN_LOG_LIMIT,
    );
    const updated: LifeOpsGoalDefinition = {
      ...current,
      reviewState: args.progress ?? current.reviewState,
      metadata: { ...current.metadata, checkinLog },
      updatedAt: atIso,
    };
    await this.repository().updateGoalCheckin(agentId, goal.id, {
      reviewState: updated.reviewState,
      checkinLog,
      updatedAt: atIso,
    });
    await this.repository().createAuditEvent({
      id: crypto.randomUUID(),
      agentId,
      eventType: "goal_updated",
      ownerType: "goal",
      ownerId: goal.id,
      reason: "goal check-in response recorded",
      inputs: {
        taskId: completedTaskId,
        note: entry.note,
        progress: entry.progress,
      },
      decision: {
        reviewState: updated.reviewState,
        checkinCount: checkinLog.length,
      },
      actor: "user",
      createdAt: atIso,
    });
    logger.info(
      `${GOALS_LOG_PREFIX} [GoalsCheckinService] recorded check-in response for goal ${goal.id} (task ${completedTaskId ?? "none"}, progress ${entry.progress ?? "unchanged"})`,
    );
    return { goal: updated, completedTaskId };
  }

  /**
   * Boot reconcile: once the runtime finished initializing, sync every goal
   * so pre-existing goals (created before this engine, or while the spine
   * was unavailable) get their check-in tasks. Failures are logged, not
   * fatal — every subsequent goal write re-syncs its own goal.
   */
  private async reconcileWhenReady(): Promise<void> {
    const runtime = this.rt();
    try {
      await Promise.race([runtime.initPromise, this.stopRequested]);
      if (this.stopping) return;
      if (!runtime.hasService(ScheduledTaskRunnerService.serviceType)) {
        logger.info(
          `${GOALS_LOG_PREFIX} [GoalsCheckinService] scheduling spine not registered on this runtime; skipping goal check-in reconcile`,
        );
        return;
      }
      await Promise.race([
        runtime.getServiceLoadPromise(ScheduledTaskRunnerService.serviceType),
        this.stopRequested,
      ]);
      if (this.stopping) return;
      const goals = await this.repository().listGoals(requireAgentId(runtime));
      for (const goal of goals) {
        if (this.stopping) return;
        await this.syncGoalCheckins(goal);
      }
      logger.info(
        `${GOALS_LOG_PREFIX} [GoalsCheckinService] boot reconcile complete for ${goals.length} goal(s)`,
      );
    } catch (error) {
      logger.error(
        { error },
        `${GOALS_LOG_PREFIX} [GoalsCheckinService] boot check-in reconcile failed; goal writes will re-sync individually`,
      );
    }
  }
}

export function getGoalsCheckinService(
  runtime: IAgentRuntime,
): GoalsCheckinService | null {
  return (
    runtime.getService<GoalsCheckinService>(GoalsCheckinService.serviceType) ??
    null
  );
}
