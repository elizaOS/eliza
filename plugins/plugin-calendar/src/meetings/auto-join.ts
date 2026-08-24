/**
 * Calendar → meeting auto-join wiring on the frozen ScheduledTask spine.
 *
 * When a synced calendar event carries a conference link that
 * `parseMeetingUrl` recognizes AND the per-agent auto-join policy allows it,
 * this module keeps exactly one join task per event alive on the standard
 * scheduled-task runner (`@elizaos/plugin-scheduling`):
 *
 * - A per-event anchor `calendar_event.start:<eventId>` is registered on the
 *   runtime anchor registry (override on re-register), resolving to the
 *   event's current `startAt`. Rescheduled events re-register the anchor, so
 *   the join task follows the event without editing the task row.
 * - Policy `"all"`: one `kind: "custom"` task with
 *   `trigger: { kind: "relative_to_anchor", offsetMinutes: -1 }`,
 *   `subject: { kind: "calendar_event", id }`, dispatched through the
 *   `meeting_join` channel (see `meeting-join-dispatch.ts`).
 * - Policy `"ask"`: one `kind: "approval"` task anchored at `-15` minutes
 *   (delivered in-app via the spine's default channel), plus the join task
 *   with `trigger: { kind: "after_task", taskId: approval, outcome:
 *   "completed" }` so the agent only joins after the owner approves.
 * - Policy `"off"`: no tasks; any live auto-join tasks for the reconciled
 *   events are dismissed.
 *
 * No second scheduler, no promptInstructions-driven behavior — everything is
 * structural fields on the frozen `ScheduledTask` schema.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  createAnchorRegistry,
  getAnchorRegistry,
  getScheduledTaskRunner,
  registerAnchorRegistry,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRunnerHandle,
} from "@elizaos/plugin-scheduling";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  MEETING_PLATFORM_LABELS,
  type ParsedMeetingUrl,
  parseMeetingUrl,
} from "@elizaos/shared";
import {
  type MeetingAutoJoinPolicy,
  readMeetingAutoJoinSettings,
} from "./auto-join-settings.js";
import { MEETING_JOIN_CHANNEL_KEY } from "./meeting-join-dispatch.js";

const LOG_PREFIX = "[CalendarMeetingAutoJoin]";
const CREATED_BY = "@elizaos/plugin-calendar";

/** Marker on every task this module owns. */
export const AUTO_JOIN_METADATA_FLAG = "calendarAutoJoin";

/** Join `offsetMinutes` relative to the event-start anchor. */
export const JOIN_OFFSET_MINUTES = -1;
/** Approval lead time before the event start (ask mode). */
export const APPROVAL_OFFSET_MINUTES = -15;

export function eventStartAnchorKey(eventId: string): string {
  return `calendar_event.start:${eventId}`;
}

/**
 * Register (or re-register) the per-event start anchor. Uses the runtime
 * anchor registry that the scheduling host (`plugin-personal-assistant`)
 * binds into the runner deps; when no registry exists yet, one is created and
 * registered so the host picks it up (its `resolveRuntimeAnchorRegistry`
 * prefers an existing per-runtime registry).
 */
export function registerEventStartAnchor(
  runtime: IAgentRuntime,
  eventId: string,
  startAtIso: string,
): void {
  let registry = getAnchorRegistry(runtime);
  if (!registry) {
    registry = createAnchorRegistry();
    registerAnchorRegistry(runtime, registry);
  }
  registry.register(
    {
      anchorKey: eventStartAnchorKey(eventId),
      describe: {
        label: `Calendar event ${eventId} start (${startAtIso})`,
        provider: CREATED_BY,
      },
      resolve() {
        return { atIso: startAtIso };
      },
    },
    { override: true },
  );
}

function resolveRunner(
  runtime: IAgentRuntime,
  agentId: string,
): ScheduledTaskRunnerHandle | null {
  try {
    return getScheduledTaskRunner(runtime, { agentId });
  } catch (error) {
    logger.warn(
      { src: "calendar:meeting-auto-join", agentId, error },
      `${LOG_PREFIX} ScheduledTask runner unavailable; skipping meeting auto-join reconcile.`,
    );
    return null;
  }
}

interface AutoJoinTaskMetadata extends Record<string, unknown> {
  [AUTO_JOIN_METADATA_FLAG]: true;
  calendarEventId: string;
  meetingUrl: string;
  platform: ParsedMeetingUrl["platform"];
  eventStartAt: string;
  autoJoinMode: MeetingAutoJoinPolicy;
  role: "join" | "approval";
}

function isAutoJoinTask(task: ScheduledTask): boolean {
  return task.metadata?.[AUTO_JOIN_METADATA_FLAG] === true;
}

/**
 * Event + policy-generation idempotency key. Every schedule this module issues
 * carries one; the scheduling spine enforces at-most-one row per
 * `(agentId, idempotencyKey)` (unique constraint in the SQL store, replayed by
 * `scheduleWithResult` — see `plugin-scheduling` `runner.ts`/`db-schema.ts`).
 * That is the concurrency contract the reconcile path relies on: two concurrent
 * syncs that both observe an empty task set compute the SAME key for the same
 * event/generation/role, so only one row is ever inserted and the loser
 * replays it instead of creating a duplicate approval/join.
 *
 * `generation` is a monotonic per-event token (the count of prior task
 * lifecycles for the event; task rows are only ever added, never removed, and
 * each policy epoch is retired by dismissal before the next is scheduled). A
 * fresh epoch therefore always gets a strictly higher generation and a fresh
 * key, so a policy round-trip back to a mode (all→ask→all) is a NEW generation
 * rather than a collision with the retired one.
 */
function autoJoinIdempotencyKey(
  eventId: string,
  generation: number,
  role: "join" | "approval",
): string {
  return `calendar-auto-join:${eventId}:g${generation}:${role}`;
}

async function listAutoJoinTasksForEvent(
  runner: ScheduledTaskRunnerHandle,
  eventId: string,
): Promise<ScheduledTask[]> {
  const tasks = await runner.list({
    subject: { kind: "calendar_event", id: eventId },
    source: "plugin",
  });
  return tasks.filter(isAutoJoinTask);
}

async function dismissTasks(
  runner: ScheduledTaskRunnerHandle,
  tasks: ScheduledTask[],
  reason: string,
): Promise<void> {
  for (const task of tasks) {
    // Retire any non-dismissed task, terminal (completed/skipped/expired/
    // failed) included: dismissing a stale terminal task is what starts a
    // fresh policy generation on the next matching sync. Already-dismissed
    // tasks are skipped so a periodic sync does not re-dismiss them.
    if (task.state.status === "dismissed") continue;
    await runner.apply(task.taskId, "dismiss", { reason });
  }
}

function startLabel(event: LifeOpsCalendarEvent): string {
  const parsed = Date.parse(event.startAt);
  if (!Number.isFinite(parsed)) return event.startAt;
  return new Date(parsed).toISOString();
}

function joinTaskInput(
  event: LifeOpsCalendarEvent,
  parsed: ParsedMeetingUrl,
  mode: MeetingAutoJoinPolicy,
  trigger: ScheduledTaskInput["trigger"],
  generation: number,
): ScheduledTaskInput {
  const metadata: AutoJoinTaskMetadata = {
    [AUTO_JOIN_METADATA_FLAG]: true,
    calendarEventId: event.id,
    meetingUrl: parsed.meetingUrl,
    platform: parsed.platform,
    eventStartAt: event.startAt,
    autoJoinMode: mode,
    role: "join",
  };
  return {
    kind: "custom",
    idempotencyKey: autoJoinIdempotencyKey(event.id, generation, "join"),
    promptInstructions: `Join the ${MEETING_PLATFORM_LABELS[parsed.platform]} meeting "${event.title.trim() || "Untitled event"}" as the owner's notetaker.`,
    trigger,
    priority: "high",
    escalation: {
      steps: [{ delayMinutes: 0, channelKey: MEETING_JOIN_CHANNEL_KEY }],
    },
    output: {
      destination: "channel",
      target: `${MEETING_JOIN_CHANNEL_KEY}:${event.id}`,
    },
    subject: { kind: "calendar_event", id: event.id },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: CREATED_BY,
    ownerVisible: true,
    metadata,
    executionProfile: "bg-heavy-fgs",
  };
}

function approvalTaskInput(
  event: LifeOpsCalendarEvent,
  parsed: ParsedMeetingUrl,
  generation: number,
): ScheduledTaskInput {
  const metadata: AutoJoinTaskMetadata = {
    [AUTO_JOIN_METADATA_FLAG]: true,
    calendarEventId: event.id,
    meetingUrl: parsed.meetingUrl,
    platform: parsed.platform,
    eventStartAt: event.startAt,
    autoJoinMode: "ask",
    role: "approval",
  };
  return {
    kind: "approval",
    idempotencyKey: autoJoinIdempotencyKey(event.id, generation, "approval"),
    promptInstructions: `Send the agent to join "${event.title.trim() || "Untitled event"}" on ${MEETING_PLATFORM_LABELS[parsed.platform]} at ${startLabel(event)}? Approve to have it attend and transcribe the meeting.`,
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: APPROVAL_OFFSET_MINUTES,
    },
    priority: "high",
    subject: { kind: "calendar_event", id: event.id },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: CREATED_BY,
    ownerVisible: true,
    metadata,
    executionProfile: "bg-light-30s",
  };
}

function taskRole(task: ScheduledTask): "join" | "approval" | null {
  const role = task.metadata?.role;
  return role === "join" || role === "approval" ? role : null;
}

function taskMode(task: ScheduledTask): string | null {
  const mode = task.metadata?.autoJoinMode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Reconcile one event against the current policy. Returns the tasks that are
 * live for the event after reconciliation (diagnostics/tests).
 */
async function reconcileEvent(
  runtime: IAgentRuntime,
  runner: ScheduledTaskRunnerHandle,
  event: LifeOpsCalendarEvent,
  policy: MeetingAutoJoinPolicy,
  nowMs: number,
): Promise<ScheduledTask[]> {
  const parsed = event.conferenceLink
    ? parseMeetingUrl(event.conferenceLink)
    : null;
  const existing = await listAutoJoinTasksForEvent(runner, event.id);

  // Monotonic per-event generation token: the count of task lifecycles that
  // already exist for this event (rows are only ever added, never removed).
  // Concurrent syncs that both observe the same snapshot compute the SAME
  // generation — hence the same idempotency key — so the spine dedups them;
  // each retired policy epoch adds rows, so the next epoch gets a strictly
  // higher generation and a fresh key.
  const generation = existing.length;

  const endMs = Date.parse(event.endAt);
  const eventOver = Number.isFinite(endMs) && endMs <= nowMs;

  if (!parsed || policy === "off" || eventOver) {
    // Retire the whole non-dismissed lifecycle (live and terminal) so that
    // re-enabling later starts a fresh generation instead of resurrecting a
    // completed task from before this event window was disabled.
    const retire = existing.filter((task) => task.state.status !== "dismissed");
    if (retire.length > 0) {
      const reason = !parsed
        ? "conference link removed or unrecognized"
        : policy === "off"
          ? "meeting auto-join disabled"
          : "event already ended";
      await dismissTasks(runner, retire, reason);
      logger.info(
        {
          src: "calendar:meeting-auto-join",
          eventId: event.id,
          dismissed: retire.length,
          reason,
        },
        `${LOG_PREFIX} Dismissed ${retire.length} auto-join task(s) for event ${event.id}: ${reason}.`,
      );
    }
    return [];
  }

  // Keep the anchor current so a rescheduled event fires at the new start.
  registerEventStartAnchor(runtime, event.id, event.startAt);

  // Tasks created under a different policy mode are stale — dismiss and
  // recreate under the current mode. This retires terminal (completed/…)
  // tasks too, not just live ones: a completed task from a superseded policy
  // generation must not survive to be treated as the current lifecycle when
  // the policy later round-trips back to that mode (all→ask→all,
  // ask→all→ask). Without retiring it, `existingForMode` below would find the
  // old terminal task and suppress the new generation's fresh task.
  const stale = existing.filter(
    (task) => taskMode(task) !== policy && task.state.status !== "dismissed",
  );
  if (stale.length > 0) {
    await dismissTasks(
      runner,
      stale,
      `auto-join policy changed to "${policy}"`,
    );
  }

  // Gate (re)creation on tasks that already exist for this event under the
  // current policy mode in ANY non-dismissed state — not just live ones. A
  // one-shot approval/join whose lifecycle already ran (terminal status
  // completed/skipped/expired/failed) must NOT be resurrected within the same
  // event window under the CURRENT policy generation: recreating a completed
  // approval re-prompts the owner to approve a meeting they already approved,
  // and recreating a completed join schedules a fresh join anchored at
  // start-1min (now in the past → due immediately) that re-joins the same
  // meeting. Only `dismissed` — the state reserved for tasks we intentionally
  // retired — is treated as absent. Tasks from a superseded generation are
  // already dismissed by the stale pass above, so a policy round-trip back to
  // this mode reaches this filter with an empty set and creates fresh tasks.
  const existingForMode = existing.filter(
    (task) => taskMode(task) === policy && task.state.status !== "dismissed",
  );

  if (policy === "all") {
    const join = existingForMode.find((task) => taskRole(task) === "join");
    if (join) return [join];
    const scheduled = await runner.schedule(
      joinTaskInput(
        event,
        parsed,
        "all",
        {
          kind: "relative_to_anchor",
          anchorKey: eventStartAnchorKey(event.id),
          offsetMinutes: JOIN_OFFSET_MINUTES,
        },
        generation,
      ),
    );
    logger.info(
      {
        src: "calendar:meeting-auto-join",
        eventId: event.id,
        taskId: scheduled.taskId,
        platform: parsed.platform,
      },
      `${LOG_PREFIX} Scheduled meeting join for event ${event.id} (${parsed.platform}) at event start.`,
    );
    return [scheduled];
  }

  // policy === "ask"
  let approval = existingForMode.find((task) => taskRole(task) === "approval");
  if (!approval) {
    approval = await runner.schedule(
      approvalTaskInput(event, parsed, generation),
    );
    logger.info(
      {
        src: "calendar:meeting-auto-join",
        eventId: event.id,
        taskId: approval.taskId,
      },
      `${LOG_PREFIX} Scheduled join approval for event ${event.id}.`,
    );
  }
  let join = existingForMode.find((task) => taskRole(task) === "join");
  if (!join) {
    join = await runner.schedule(
      joinTaskInput(
        event,
        parsed,
        "ask",
        {
          kind: "after_task",
          taskId: approval.taskId,
          outcome: "completed",
        },
        generation,
      ),
    );
    logger.info(
      {
        src: "calendar:meeting-auto-join",
        eventId: event.id,
        taskId: join.taskId,
        approvalTaskId: approval.taskId,
      },
      `${LOG_PREFIX} Scheduled approval-gated meeting join for event ${event.id}.`,
    );
  }
  return [approval, join];
}

export interface ReconcileMeetingAutoJoinArgs {
  runtime: IAgentRuntime;
  agentId: string;
  /** Current (post-sync) events for the synced window. */
  events: readonly LifeOpsCalendarEvent[];
  /** Event ids removed from the window by this sync. */
  removedEventIds?: readonly string[];
  now?: () => Date;
}

/**
 * Sync-time entry point. Called by `CalendarService` after each Google/Apple
 * feed sync (and on policy change). Never throws — auto-join failures must
 * not break calendar sync.
 */
export async function reconcileMeetingAutoJoin(
  args: ReconcileMeetingAutoJoinArgs,
): Promise<void> {
  const { runtime, agentId, events, removedEventIds = [] } = args;
  const runner = resolveRunner(runtime, agentId);
  if (!runner) return;
  const nowMs = (args.now?.() ?? new Date()).getTime();
  try {
    const settings = await readMeetingAutoJoinSettings(runtime);
    for (const event of events) {
      await reconcileEvent(runtime, runner, event, settings.policy, nowMs);
    }
    for (const eventId of removedEventIds) {
      // Retire the whole non-dismissed lifecycle (terminal included), not just
      // live tasks: a completed approval/join left non-dismissed would be
      // treated as the current lifecycle by `existingForMode` and suppress a
      // fresh generation if the same event id later reappears in the window.
      const retire = (await listAutoJoinTasksForEvent(runner, eventId)).filter(
        (task) => task.state.status !== "dismissed",
      );
      if (retire.length > 0) {
        await dismissTasks(runner, retire, "calendar event deleted");
        logger.info(
          {
            src: "calendar:meeting-auto-join",
            eventId,
            dismissed: retire.length,
          },
          `${LOG_PREFIX} Dismissed ${retire.length} auto-join task(s) for deleted event ${eventId}.`,
        );
      }
    }
  } catch (error) {
    logger.error(
      { src: "calendar:meeting-auto-join", agentId, error },
      `${LOG_PREFIX} Meeting auto-join reconcile failed.`,
    );
  }
}

/**
 * Dismiss every non-dismissed auto-join task owned by this module. Used when
 * the policy is switched to `"off"`. Terminal (completed/skipped/expired/
 * failed) tasks are retired too, not just live ones: a completed task left
 * non-dismissed would otherwise be resurrected by `existingForMode` when the
 * same mode is later re-enabled, suppressing the fresh generation.
 */
export async function cancelAllMeetingAutoJoinTasks(
  runtime: IAgentRuntime,
  agentId: string,
): Promise<number> {
  const runner = resolveRunner(runtime, agentId);
  if (!runner) return 0;
  const tasks = (await runner.list({ source: "plugin" }))
    .filter(isAutoJoinTask)
    .filter((task) => task.state.status !== "dismissed");
  await dismissTasks(runner, tasks, "meeting auto-join disabled");
  if (tasks.length > 0) {
    logger.info(
      { src: "calendar:meeting-auto-join", agentId, dismissed: tasks.length },
      `${LOG_PREFIX} Dismissed ${tasks.length} auto-join task(s): policy set to off.`,
    );
  }
  return tasks.length;
}

/**
 * Boot-time anchor restore. Anchor registrations are in-memory, so after a
 * restart the persisted join tasks would sit `anchor_unresolved` until the
 * next feed sync. This re-registers the start anchor for every upcoming
 * event that still has a live auto-join task.
 */
export async function restoreMeetingAutoJoinAnchors(
  runtime: IAgentRuntime,
  _agentId: string,
  events: readonly LifeOpsCalendarEvent[],
): Promise<void> {
  const settings = await readMeetingAutoJoinSettings(runtime);
  if (settings.policy === "off") return;
  for (const event of events) {
    const parsed = event.conferenceLink
      ? parseMeetingUrl(event.conferenceLink)
      : null;
    if (!parsed) continue;
    registerEventStartAnchor(runtime, event.id, event.startAt);
  }
}
