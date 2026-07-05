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
 */

import type { Content, IAgentRuntime, UUID } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
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
  /** Coarse staleness indicator for a progress-expected task that has gone
   *  idle (e.g. "⏳ idle 8m+"), or undefined when fresh. Folded into the digest
   *  line so a genuinely STUCK task changes the digest and re-posts, instead of
   *  being deduped into silence after the first post. */
  staleness?: string;
  /** The originating chat target; null tasks (no chat origin) are skipped. */
  origin: { roomId: string; source: string } | null;
  /** True when the task is parked in the admission queue (waiting for a session
   *  slot). Folded into the digest as a queued count, not a per-task line. */
  queued?: boolean;
}

// Coarse staleness bands (minutes → label), highest first. Bucketed on purpose:
// steady progress within a band still dedups, but a stall crossing into the
// next band changes the digest and re-posts, escalating as it worsens.
const SUPERVISOR_STALENESS_BANDS: ReadonlyArray<readonly [number, string]> = [
  [45, "⚠️ stalled 45m+"],
  [20, "⏳ idle 20m+"],
  [8, "⏳ idle 8m+"],
  [3, "⏳ idle 3m+"],
];

/** Coarse staleness label for a progress-expected task, or undefined when it is
 *  fresh / has no known activity time. Pure (takes `nowMs`) so the digest stays
 *  deterministic and unit-testable without a clock. */
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

/** Statuses where the sub-agent is expected to be MAKING PROGRESS, so a long
 *  idle indicates a stall worth surfacing. (waiting_on_user / blocked are
 *  legitimately idle — no stall indicator there.) */
const PROGRESS_EXPECTED_STATUSES: ReadonlySet<OrchestratorTaskStatus> = new Set(
  ["active", "validating"],
);

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
      const detail = v.sessionLabel ? ` · ${v.sessionLabel}` : "";
      const sessions =
        v.activeSessions > 0 ? ` (${v.activeSessions} running)` : "";
      const stale = v.staleness ? ` ${v.staleness}` : "";
      return `${statusEmoji(v.status)} ${v.label} — ${v.status}${sessions}${detail}${stale}`;
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
    if (seen.get(roomId) === digest) {
      skipped.push(roomId);
      continue;
    }
    try {
      await send({ source, roomId: roomId as UUID }, { text: digest, source });
      seen.set(roomId, digest);
      posted.push(roomId);
    } catch (error) {
      // error-policy:J7 per-room send loop must not die on one delivery failure;
      // seen is left unset so the next tick retries — warn-observable, self-healing.
      // A delivery failure must not abort the rest of the tick or poison the
      // dedup cache (so the next tick retries this room).
      logger.warn(
        `[TaskSupervisorService] digest delivery failed for room ${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
  ) => Promise<unknown>;
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
  private readonly digestSinks = new Map<
    string,
    Set<TaskSupervisorDigestSink>
  >();

  static async start(runtime: IAgentRuntime): Promise<TaskSupervisorService> {
    const svc = new TaskSupervisorService(runtime);
    if (svc.enabled()) svc.startTimer();
    return svc;
  }

  private enabled(): boolean {
    return this.runtime.getSetting("ELIZA_ORCHESTRATOR_SUPERVISOR") !== "0";
  }

  private intervalMs(): number {
    const raw = this.runtime.getSetting(
      "ELIZA_ORCHESTRATOR_SUPERVISOR_INTERVAL_MS",
    );
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? n : DEFAULT_INTERVAL_MS;
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
    if (typeof fallback === "function") return fallback(target, content);
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
      // Live tasks drive per-task lines; admission-parked tasks (status `open`
      // with an admission record) drive the queued-count line.
      const surfaced = tasks.filter(
        (t) => LIVE_STATUSES.has(t.status) || t.admission?.state === "queued",
      );
      const now = Date.now();
      const views: SupervisorTaskView[] = await Promise.all(
        surfaced.map(async (t) => ({
          id: t.id,
          label: t.title,
          status: t.status,
          activeSessions: t.activeSessionCount,
          sessionLabel: t.latestSessionLabel,
          // Surface a stall only for progress-expected statuses; waiting_on_user
          // / blocked are legitimately idle.
          staleness: PROGRESS_EXPECTED_STATUSES.has(t.status)
            ? supervisorStalenessLabel(t.latestActivityAt, now)
            : undefined,
          origin: await taskSvc.getTaskOriginTarget(t.id),
          queued: t.admission?.state === "queued",
        })),
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

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.seen.clear();
    this.digestSinks.clear();
  }
}
