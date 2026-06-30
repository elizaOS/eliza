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
  /** The originating chat target; null tasks (no chat origin) are skipped. */
  origin: { roomId: string; source: string } | null;
}

/** Compose the digest body for one room's set of live tasks. Deterministic. */
export function composeRoomDigest(views: SupervisorTaskView[]): string {
  const header =
    views.length === 1
      ? "📡 Task update"
      : `📡 Task update — ${views.length} active`;
  const lines = views
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((v) => {
      const detail = v.sessionLabel ? ` · ${v.sessionLabel}` : "";
      const sessions =
        v.activeSessions > 0 ? ` (${v.activeSessions} running)` : "";
      return `${statusEmoji(v.status)} ${v.label} — ${v.status}${sessions}${detail}`;
    });
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
    if (!v.origin || !LIVE_STATUSES.has(v.status)) continue;
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

export type TaskSupervisorDigestTarget = { source: string; roomId: UUID };

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
  /** roomId → last-posted digest, for change-driven dedup. */
  private readonly seen = new Map<string, string>();
  private readonly digestSinks = new Map<string, TaskSupervisorDigestSink>();

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
      void this.runOnce();
    }, this.intervalMs());
    // The digest loop must never, by itself, keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  registerDigestSink(
    source: string,
    sink: TaskSupervisorDigestSink,
  ): () => void {
    this.digestSinks.set(source, sink);
    return () => {
      if (this.digestSinks.get(source) === sink) {
        this.digestSinks.delete(source);
      }
    };
  }

  private async sendDigest(
    target: TaskSupervisorDigestTarget,
    content: Content,
    fallback?: RuntimeWithSendTarget["sendMessageToTarget"],
  ): Promise<unknown> {
    const sink = this.digestSinks.get(target.source);
    if (sink) {
      try {
        const handled = await sink(target, content);
        if (handled !== false) return handled;
      } catch (error) {
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
    const tasks = await taskSvc.listTasks({ includeArchived: false });
    const live = tasks.filter((t) => LIVE_STATUSES.has(t.status));
    const views: SupervisorTaskView[] = await Promise.all(
      live.map(async (t) => ({
        id: t.id,
        label: t.title,
        status: t.status,
        activeSessions: t.activeSessionCount,
        sessionLabel: t.latestSessionLabel,
        origin: await taskSvc.getTaskOriginTarget(t.id),
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
