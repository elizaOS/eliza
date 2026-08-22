/**
 * TaskSupervisorService — the multi-task "juggler" (#8900, EPIC #8885).
 *
 * The orchestrator stores N tasks but nothing proactively tells the user how
 * they're all doing — on Telegram (no side tabs) the user has to keep asking.
 * This service ticks on an interval, scans the in-flight tasks per originating
 * room, and posts a compact status digest back to that room — but only when the
 * digest CHANGED since the last post, so a steady state never spams the chat.
 *
 * The tick logic is a pure function (`runSupervisorTick`) over injected views so
 * it unit-tests without timers, services, or a runtime.
 *
 * Damping, layered on the change-driven dedup: a task younger than one tick
 * interval is not digested yet (a sub-interval inline build finishes before a
 * digest could say anything its completion relay won't say better), a room
 * whose task just relayed a completion is suppressed for that tick (the digest
 * must not be a second uncoordinated message about the same event), and a task
 * held un-done by a verification gate after reporting completion digests on
 * status transitions only. See noteTaskCompletion for the cross-surface half.
 *
 * Stall handling is OWNER-scoped, never room-scoped: a task's idle/stalled
 * age is deliberately NOT part of the digest, because folding an incrementing
 * idle timer into the room post turns a single stuck task into a stream of
 * unprompted "still stalled" messages in a shared channel (completions already
 * relay; a mere stall is noise there). A task that crosses the STALLED band
 * instead escalates once through `runtime.reportError`, which feeds the
 * RECENT_ERRORS ring and the owner-escalation threshold — quiet, owner-facing,
 * and deduplicated until the task recovers.
 */

import type {
  Content,
  IAgentRuntime,
  SendHandlerResult,
  UUID,
} from "@elizaos/core";
import {
  logger,
  requireConfirmedSendHandlerDelivery,
  Service,
} from "@elizaos/core";
import type { OrchestratorTaskStatus } from "./orchestrator-task-types.js";

export const TASK_SUPERVISOR_SERVICE_TYPE = "ORCHESTRATOR_TASK_SUPERVISOR";

/** Statuses worth surfacing in a proactive digest — in-flight, needs-attention. */
const LIVE_STATUSES: ReadonlySet<OrchestratorTaskStatus> = new Set([
  "active",
  "validating",
  "waiting_on_user",
  "blocked",
]);

const STATUS_EMOJI: Record<OrchestratorTaskStatus, string> = {
  open: "📋",
  active: "🚀",
  validating: "🔍",
  waiting_on_user: "⏳",
  blocked: "⛔",
  done: "✅",
  failed: "❌",
  archived: "🗄️",
  interrupted: "⏸️",
};

export function statusEmoji(status: OrchestratorTaskStatus): string {
  return STATUS_EMOJI[status] ?? "•";
}

/** A task reduced to just what a digest line needs. */
export interface SupervisorTaskView {
  id: string;
  label: string;
  status: OrchestratorTaskStatus;
  /** Active (non-terminal) sub-agent sessions for this task. */
  activeSessions: number;
  /** Latest session label (often "agentType · account"), if any. */
  sessionLabel?: string | null;
  /** The originating chat target; null tasks (no chat origin) are skipped. */
  origin: { roomId: string; source: string } | null;
  /** True when the task is parked in the admission queue (waiting for a session
   *  slot). Folded into the digest as a queued count, not a per-task line. */
  queued?: boolean;
  /** True when this task reported completion within the CURRENT tick window.
   *  The router relays that completion to the origin room the moment it fires,
   *  so a digest on its heels is a second uncoordinated message about the same
   *  event — the tick suppresses the room instead, and change-driven dedup
   *  owns any later re-post. */
  recentlyRelayed?: boolean;
  /** True when this task has reported completion at least once but is still
   *  held un-done by a verification gate (URL-verify retry, residuals). The
   *  verify-retry respawns churn session labels/counts while the gate holds —
   *  each mutation would re-post "still active" noise after the user already
   *  received the completion relay. The digest line freezes to structural
   *  status for such tasks; a real status transition still changes the digest
   *  and posts. */
  heldAfterCompletion?: boolean;
}

// Coarse staleness bands (minutes → label), highest first. These feed the
// OWNER-scoped stall escalation (and its context text), never the room digest:
// an incrementing idle timer in the digest would change it every band crossing
// and re-post "still stalled" noise into a shared channel.
const SUPERVISOR_STALENESS_BANDS: ReadonlyArray<readonly [number, string]> = [
  [45, "⚠️ stalled 45m+"],
  [20, "⏳ idle 20m+"],
  [8, "⏳ idle 8m+"],
  [3, "⏳ idle 3m+"],
];

/** Idle age (minutes) at which a progress-expected task counts as STALLED and
 *  escalates to the owner — the top staleness band. */
const STALLED_BAND_MINUTES = SUPERVISOR_STALENESS_BANDS[0][0];

/** Coarse staleness label for a progress-expected task, or undefined when it is
 *  fresh / has no known activity time. Pure (takes `nowMs`) so the escalation
 *  context stays deterministic and unit-testable without a clock. */
export function supervisorStalenessLabel(
  latestActivityAt: number | null | undefined,
  nowMs: number,
): string | undefined {
  if (typeof latestActivityAt !== "number" || latestActivityAt <= 0) {
    return undefined;
  }
  const ageMin = (nowMs - latestActivityAt) / 60_000;
  for (const [min, label] of SUPERVISOR_STALENESS_BANDS) {
    if (ageMin >= min) return label;
  }
  return undefined;
}

/** Whether a progress-expected task has crossed the STALLED band. Pure; an
 *  unknown activity time is never "stalled" (no false owner escalations). */
export function isSupervisorStalled(
  latestActivityAt: number | null | undefined,
  nowMs: number,
): boolean {
  if (typeof latestActivityAt !== "number" || latestActivityAt <= 0) {
    return false;
  }
  return nowMs - latestActivityAt >= STALLED_BAND_MINUTES * 60_000;
}

/** Statuses where the sub-agent is expected to be MAKING PROGRESS, so a long
 *  idle indicates a stall worth surfacing. (waiting_on_user / blocked are
 *  legitimately idle — no stall indicator there.) */
const PROGRESS_EXPECTED_STATUSES: ReadonlySet<OrchestratorTaskStatus> = new Set(
  ["active", "validating"],
);

/** Whether a task is old enough to appear in a digest at all. A task younger
 *  than one tick interval either finishes before the digest could say anything
 *  its completion relay won't say better (the sub-interval inline build), or
 *  survives into the next tick and posts then — so the FIRST digest is gated
 *  on min task-age > tick interval. Fail-open on an unparseable timestamp:
 *  this is a burst damper, and silently muting a task's digests forever would
 *  be worse than one early post. */
export function taskOldEnoughForDigest(
  createdAt: string,
  nowMs: number,
  minAgeMs: number,
): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return true;
  return nowMs - createdMs >= minAgeMs;
}

/** Compose the digest body for one room's set of live tasks. Deterministic.
 * Queued (admission-parked) tasks are summarized as a count line, not per-task
 * rows, so a backlog of waiting tasks doesn't flood the digest. */
export function composeRoomDigest(views: SupervisorTaskView[]): string {
  const active = views.filter((v) => !v.queued);
  const queuedCount = views.filter((v) => v.queued).length;
  const header =
    active.length === 1
      ? "📡 Task update"
      : `📡 Task update — ${active.length} active`;
  const lines = active
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((v) => {
      // Post-completion hold: only the structural status may drive a re-post
      // (see heldAfterCompletion) — session churn on a gate-held task is
      // noise, not news.
      if (v.heldAfterCompletion) {
        return `${statusEmoji(v.status)} ${v.label} — ${v.status}`;
      }
      const detail = v.sessionLabel ? ` · ${v.sessionLabel}` : "";
      const sessions =
        v.activeSessions > 0 ? ` (${v.activeSessions} running)` : "";
      // Deliberately no idle/staleness suffix: a stall is owner-escalation
      // material (see escalateStalledTasks), not a room broadcast — and its
      // ticking age must not mutate the digest into change-driven re-posts.
      return `${statusEmoji(v.status)} ${v.label} — ${v.status}${sessions}${detail}`;
    });
  if (queuedCount > 0) {
    lines.push(`⏳ ${queuedCount} queued (waiting for a session slot)`);
  }
  return [header, ...lines].join("\n");
}

export interface SupervisorTickResult {
  /** Room ids a fresh digest was posted to this tick. */
  posted: string[];
  /** Room ids whose digest was unchanged (deduped, not posted). */
  skipped: string[];
}

/**
 * One supervisor tick: group live tasks by origin room, and post each room's
 * digest only when it changed since `seen` last recorded it. Pure except for the
 * injected `send`; mutates `seen` to remember what was posted (and prunes rooms
 * that no longer have live tasks so a later re-activation re-posts).
 */
export async function runSupervisorTick(
  views: SupervisorTaskView[],
  send: (
    target: { source: string; roomId: UUID },
    content: Content,
  ) => Promise<unknown>,
  seen: Map<string, string>,
): Promise<SupervisorTickResult> {
  const byRoom = new Map<
    string,
    { source: string; views: SupervisorTaskView[] }
  >();
  for (const v of views) {
    // Queued tasks are `open` (not a LIVE_STATUS) but still belong in the digest
    // as the queued-count line, so admit them past the status gate.
    if (!v.origin || (!v.queued && !LIVE_STATUSES.has(v.status))) continue;
    const bucket = byRoom.get(v.origin.roomId) ?? {
      source: v.origin.source,
      views: [],
    };
    bucket.views.push(v);
    byRoom.set(v.origin.roomId, bucket);
  }

  // Drop remembered rooms that no longer have live tasks, so a future re-spawn
  // in that room posts a fresh digest instead of being deduped against a stale one.
  for (const roomId of [...seen.keys()]) {
    if (!byRoom.has(roomId)) seen.delete(roomId);
  }

  const posted: string[] = [];
  const skipped: string[] = [];
  for (const [roomId, { source, views: roomViews }] of byRoom) {
    const digest = composeRoomDigest(roomViews);
    const last = seen.get(roomId);
    if (last === digest || last === `undeliverable:${digest}`) {
      skipped.push(roomId);
      continue;
    }
    // Cross-surface arbitration: a completion relay for a task in this room
    // already posted within the current tick window, so this digest would be
    // a second uncoordinated message about the same event. Record the digest
    // as seen so only a future CHANGE re-posts — the same change-driven
    // contract the permanent-failure damper below uses.
    if (roomViews.some((v) => v.recentlyRelayed)) {
      seen.set(roomId, digest);
      skipped.push(roomId);
      continue;
    }
    try {
      await send({ source, roomId: roomId as UUID }, { text: digest, source });
      seen.set(roomId, digest);
      posted.push(roomId);
    } catch (error) {
      // error-policy:J7 per-room send loop must not die on one delivery failure —
      // warn-observable; a failure must not abort the rest of the tick.
      logger.warn(
        `[TaskSupervisorService] digest delivery failed for room ${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Permanent-failure damper: remember the digest that failed so the loop
      // retries only when the digest CHANGES — structural transitions mutate
      // the digest and room pruning resets state on task turnover, so live
      // rooms still re-attempt without warn-looping every tick against a
      // permanently undeliverable target.
      seen.set(roomId, `undeliverable:${digest}`);
    }
  }
  return { posted, skipped };
}

const DEFAULT_INTERVAL_MS = 45_000;
const MIN_INTERVAL_MS = 5_000;

type RuntimeWithSendTarget = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID; accountId?: string },
    content: Content,
  ) => SendHandlerResult;
};

export type TaskSupervisorDigestTarget = {
  source: string;
  roomId: UUID;
  accountId?: string;
};

export type TaskSupervisorDigestSink = (
  target: TaskSupervisorDigestTarget,
  content: Content,
) => Promise<boolean | undefined> | boolean | undefined;

interface TaskServiceLike {
  listTasks(filter?: { includeArchived?: boolean }): Promise<
    Array<{
      id: string;
      title: string;
      status: OrchestratorTaskStatus;
      activeSessionCount: number;
      latestSessionLabel: string | null;
      latestActivityAt: number | null;
      createdAt: string;
      admission?: { state: "queued" } | undefined;
    }>
  >;
  getTaskOriginTarget(
    taskId: string,
  ): Promise<{ roomId: string; source: string } | null>;
}

export class TaskSupervisorService extends Service {
  static serviceType = TASK_SUPERVISOR_SERVICE_TYPE;
  capabilityDescription =
    "Proactively posts a per-room status digest of all in-flight orchestrator tasks (the multi-task juggler).";

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping ticks: a slow `runOnce` (N network sends) must
   *  not have the next interval fire a concurrent one — two ticks would race the
   *  `seen` dedup map and double-post. */
  private ticking = false;
  /** roomId → last-posted digest, for change-driven dedup. */
  private readonly seen = new Map<string, string>();
  /** taskId → ms timestamp of the task's most recent reported completion.
   *  Stamped by the task service's task_complete event bridge via
   *  noteTaskCompletion — the same event whose result the router relays to
   *  the origin room — so the tick can yield to that relay instead of
   *  double-messaging the room, and can freeze the line of a task a
   *  verification gate is holding un-done. Pruned each tick against the live
   *  task list. */
  private readonly completionNotes = new Map<string, number>();
  /** taskIds already escalated to the owner for the CURRENT stall, so a stuck
   *  task escalates once — not once per tick — and re-escalates only after it
   *  recovers (or vanishes) and stalls again. */
  private readonly stallEscalated = new Set<string>();
  private readonly digestSinks = new Map<
    string,
    Set<TaskSupervisorDigestSink>
  >();

  static async start(runtime: IAgentRuntime): Promise<TaskSupervisorService> {
    const svc = new TaskSupervisorService(runtime);
    if (svc.enabled()) svc.startTimer();
    return svc;
  }

  /** Deployment lever, same resolution as the orchestrator task service's
   * levers: runtime setting first, then process.env. `getSetting` alone never
   * reads the environment, so a service-manager `EnvironmentFile` entry
   * (`ELIZA_ORCHESTRATOR_SUPERVISOR=0`) silently failed to disable the
   * supervisor — observed live when a disabled deployment kept escalating
   * stalled tasks. */
  private readSetting(key: string): string | undefined {
    const raw = this.runtime.getSetting(key);
    if (typeof raw === "string" && raw.length > 0) return raw;
    const env = process.env[key];
    return typeof env === "string" && env.length > 0 ? env : undefined;
  }

  private enabled(): boolean {
    return this.readSetting("ELIZA_ORCHESTRATOR_SUPERVISOR") !== "0";
  }

  private intervalMs(): number {
    const raw = this.readSetting("ELIZA_ORCHESTRATOR_SUPERVISOR_INTERVAL_MS");
    // `Number.parseInt` stops at the first non-digit, so "12000junk" parsed to
    // 12000 — above MIN_INTERVAL_MS, so it was accepted as a deliberate setting
    // and the supervisor swept every 12s instead of the 45s default. Require the
    // whole trimmed value to be a decimal integer; the optional leading sign is
    // kept because `parseInt` accepted it, and the MIN_INTERVAL_MS floor below
    // stays the range authority.
    const text = typeof raw === "string" ? raw.trim() : "";
    const n = /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
    return Number.isSafeInteger(n) && n >= MIN_INTERVAL_MS
      ? n
      : DEFAULT_INTERVAL_MS;
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      // Skip this tick if the previous one is still in flight — never run two
      // concurrently. `runOnce` swallows its own errors, so the `finally`
      // always clears the flag.
      if (this.ticking) return;
      this.ticking = true;
      void this.runOnce().finally(() => {
        this.ticking = false;
      });
    }, this.intervalMs());
    // The digest loop must never, by itself, keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Record that a completion was reported for a task (called from the task
   *  service's task_complete event bridge). This is the digest emitter's half
   *  of cross-surface arbitration: the router relays that completion to the
   *  origin room, so digests for the room yield within the same tick window
   *  and the task's line freezes to structural status while a verification
   *  gate holds it un-done. */
  noteTaskCompletion(taskId: string): void {
    // A disabled supervisor never ticks, so nothing would prune the notes —
    // don't accumulate them.
    if (!this.enabled()) return;
    this.completionNotes.set(taskId, Date.now());
  }

  registerDigestSink(
    source: string,
    sink: TaskSupervisorDigestSink,
  ): () => void {
    const sinks = this.digestSinks.get(source) ?? new Set();
    sinks.add(sink);
    this.digestSinks.set(source, sinks);
    return () => {
      const current = this.digestSinks.get(source);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) {
        this.digestSinks.delete(source);
      }
    };
  }

  private async sendDigest(
    target: TaskSupervisorDigestTarget,
    content: Content,
    fallback?: RuntimeWithSendTarget["sendMessageToTarget"],
  ): Promise<unknown> {
    const sinks = this.digestSinks.get(target.source);
    for (const sink of sinks ?? []) {
      try {
        const handled = await sink(target, content);
        if (handled !== false) return handled;
      } catch (error) {
        // error-policy:J4 one delivery sink unavailable → warn and fail over to
        // the next sink/fallback; if every path fails the function throws below.
        logger.warn(
          `[TaskSupervisorService] digest sink failed for ${target.source}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (typeof fallback === "function") {
      return requireConfirmedSendHandlerDelivery(
        await fallback(target, content),
      );
    }
    throw new Error(`No digest delivery path for ${target.source}`);
  }

  /** Build views from the task service and run one dedup-aware tick. */
  async runOnce(): Promise<SupervisorTickResult> {
    const taskSvc = this.runtime.getService<Service & TaskServiceLike>(
      "ORCHESTRATOR_TASK_SERVICE",
    );
    const send = (this.runtime as RuntimeWithSendTarget).sendMessageToTarget;
    if (
      !taskSvc ||
      (typeof send !== "function" && this.digestSinks.size === 0)
    ) {
      return { posted: [], skipped: [] };
    }
    // Guard the whole tick: a rejected `listTasks` / origin lookup / send would
    // otherwise surface as an unhandled rejection on every interval (the timer
    // calls this fire-and-forget) — noisy, and fatal under strict handling.
    try {
      const tasks = await taskSvc.listTasks({ includeArchived: false });
      const now = Date.now();
      const tickMs = this.intervalMs();
      // Live tasks drive per-task lines; admission-parked tasks (status `open`
      // with an admission record) drive the queued-count line. Tasks younger
      // than one tick interval are held out entirely: a sub-interval inline
      // build would otherwise draw a stale "active" digest AFTER its
      // completion relay already told the user the outcome.
      const surfaced = tasks.filter(
        (t) =>
          (LIVE_STATUSES.has(t.status) || t.admission?.state === "queued") &&
          taskOldEnoughForDigest(t.createdAt, now, tickMs),
      );
      // Completion notes live only while their task can still surface in a
      // digest; a terminal or vanished task frees its note so a later reopen
      // starts clean. Young (age-gated) tasks keep theirs — a sub-interval
      // build that completed before its first digest still needs the hold.
      const noteEligibleIds = new Set(
        tasks
          .filter((t) => LIVE_STATUSES.has(t.status) || t.status === "open")
          .map((t) => t.id),
      );
      for (const taskId of [...this.completionNotes.keys()]) {
        if (!noteEligibleIds.has(taskId)) this.completionNotes.delete(taskId);
      }
      // A stall never rides the room digest — it escalates to the OWNER, once
      // per stall, through the reportError → RECENT_ERRORS/escalation path.
      this.escalateStalledTasks(tasks, now);
      const views: SupervisorTaskView[] = await Promise.all(
        surfaced.map(async (t) => {
          const completionAt = this.completionNotes.get(t.id);
          return {
            id: t.id,
            label: t.title,
            status: t.status,
            activeSessions: t.activeSessionCount,
            sessionLabel: t.latestSessionLabel,
            origin: await taskSvc.getTaskOriginTarget(t.id),
            queued: t.admission?.state === "queued",
            ...(typeof completionAt === "number"
              ? {
                  recentlyRelayed: now - completionAt < tickMs,
                  heldAfterCompletion: true,
                }
              : {}),
          };
        }),
      );
      const result = await runSupervisorTick(
        views,
        (target, content) => this.sendDigest(target, content, send),
        this.seen,
      );
      if (result.posted.length > 0) {
        logger.info(
          `[TaskSupervisorService] digest posted to ${result.posted.length} room(s)`,
        );
      }
      return result;
    } catch (error) {
      // error-policy:J7 fire-and-forget background tick — catch keeps the interval
      // alive and prevents a per-tick unhandled rejection; warn-observable, empty
      // result is void-consumed by the timer (not read as real "nothing posted").
      logger.warn(
        `[TaskSupervisorService] tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { posted: [], skipped: [] };
    }
  }

  /**
   * Owner-scoped stall surfacing: a progress-expected task (active/validating)
   * whose last activity crossed the STALLED band is reported ONCE through
   * `runtime.reportError` — the diagnostic boundary that feeds RECENT_ERRORS
   * and the owner-escalation threshold — and never posted to the originating
   * (possibly shared/group) room. The escalation mark clears when the task
   * recovers or leaves the live set, so a later genuine re-stall re-escalates.
   */
  private escalateStalledTasks(
    tasks: Array<{
      id: string;
      title: string;
      status: OrchestratorTaskStatus;
      latestActivityAt: number | null;
    }>,
    nowMs: number,
  ): void {
    const stalledIds = new Set<string>();
    for (const t of tasks) {
      if (!PROGRESS_EXPECTED_STATUSES.has(t.status)) continue;
      if (!isSupervisorStalled(t.latestActivityAt, nowMs)) continue;
      stalledIds.add(t.id);
      if (this.stallEscalated.has(t.id)) continue;
      this.stallEscalated.add(t.id);
      this.runtime.reportError?.(
        "TaskSupervisorService.stalledTask",
        new Error(
          `Orchestrator task "${t.title}" is ${t.status} with no activity (${
            supervisorStalenessLabel(t.latestActivityAt, nowMs) ?? "stalled"
          }) — it may need a restart, a stop, or attention.`,
        ),
        {
          taskId: t.id,
          status: t.status,
          idleMs:
            typeof t.latestActivityAt === "number" && t.latestActivityAt > 0
              ? nowMs - t.latestActivityAt
              : null,
        },
      );
    }
    // Recover-then-re-escalate: drop marks for tasks that are no longer stalled
    // (fresh activity, terminal status, or gone) so a future stall re-reports.
    for (const id of [...this.stallEscalated]) {
      if (!stalledIds.has(id)) this.stallEscalated.delete(id);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.seen.clear();
    this.completionNotes.clear();
    this.stallEscalated.clear();
    this.digestSinks.clear();
  }
}
