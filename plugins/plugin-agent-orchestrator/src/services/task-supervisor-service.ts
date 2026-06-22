/**
 * Task supervisor: proactive multi-task digest loop + stalled-agent watchdog.
 *
 * The orchestrator lets one chat channel juggle many coding tasks, each driven
 * by its own sub-agent. On a side-tab UI the operator can eyeball every task at
 * once; on Telegram (no side tabs) they cannot. The supervisor closes that gap:
 * it ticks on an interval, composes a COMPACT per-room digest of every live
 * task, and posts it to the originating room — but only when the digest content
 * actually changed since the last post (change-driven, deduped, never spammy).
 *
 * The same tick runs a watchdog over each active sub-agent session:
 *  - **stalled** — no tool call / event update for N seconds → auto-send a grill
 *    prompt ("are you still working? what's blocking you?") down the existing
 *    send-to-agent path, and stamp a structural `stalled` flag on the session so
 *    the cache-stable ACTIVE_SUB_AGENTS provider can surface it WITHOUT
 *    computing time at render;
 *  - **near round-trip cap** / **spend > 80% of cap** — post a warning to the
 *    room so the operator can intervene before the loop force-stops.
 *
 * Issues #8900 (digest loop) and #8901 (stalled-agent watchdog).
 *
 * Design notes for testability: the per-tick logic lives in {@link
 * TaskSupervisorService.runTick}, callable directly with no real timers. The
 * clock is injected via the `now` field (settable in tests). The interval is
 * only started in {@link TaskSupervisorService.start} and cleared in
 * {@link TaskSupervisorService.stop}.
 *
 * @module services/task-supervisor-service
 */

import { createHash } from "node:crypto";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import { readConfigEnvKey } from "./config-env.js";
import type {
  TaskSessionDto,
  TaskThreadDetailDto,
} from "./orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "./orchestrator-task-service.js";
import type { OrchestratorTaskStatus } from "./orchestrator-task-types.js";
import { getSessionSpendUsd, readSpendCapUsd } from "./spend-allowance.js";

const DEFAULT_INTERVAL_MS = 45_000;
const DEFAULT_ROUND_TRIP_CAP = 32;
/** A session with no event/tool update for this long is considered stalled. */
const DEFAULT_STALL_TTL_MS = 120_000;
/** Warn when a session is within this many round-trips of the cap. */
const ROUND_TRIP_WARN_MARGIN = 3;
/** Warn when session spend reaches this fraction of the per-session cap. */
const SPEND_WARN_FRACTION = 0.8;

/** The task states the supervisor surfaces in a digest. Terminal/open tasks are
 *  intentionally excluded — the digest is about work in flight. */
const SUPERVISED_STATUSES: ReadonlySet<OrchestratorTaskStatus> =
  new Set<OrchestratorTaskStatus>([
    "active",
    "validating",
    "waiting_on_user",
    "blocked",
  ]);

/** Per-status time-to-live (ms) before a task is flagged stale in the digest.
 *  A task `waiting_on_user` for a while is expected; an `active` task that has
 *  not moved is a problem far sooner. */
const STATUS_STALE_TTL_MS: Record<string, number> = {
  active: 180_000,
  validating: 300_000,
  blocked: 600_000,
  waiting_on_user: 1_800_000,
};

const STATUS_EMOJI: Record<string, string> = {
  active: "🏃",
  validating: "🔎",
  waiting_on_user: "⏸️",
  blocked: "🚧",
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? "•";
}

type UuidRoomId = `${string}-${string}-${string}-${string}-${string}`;

function isUuidRoom(value: unknown): value is UuidRoomId {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/** Non-terminal task-session statuses the watchdog inspects. */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "completed",
  "done",
  "error",
  "errored",
  "cancelled",
]);

/** One task's contribution to a room digest, fully resolved structurally so the
 *  fingerprint is deterministic and the line is composed without a clock read. */
interface DigestEntry {
  taskId: string;
  label: string;
  agentType: string;
  status: OrchestratorTaskStatus;
  roundCount: number;
  lastEventSummary: string;
  stale: boolean;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readIntervalMs(): number {
  const raw = readConfigEnvKey("ELIZA_ORCHESTRATOR_SUPERVISOR_INTERVAL_MS");
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function readRoundTripCap(): number {
  const raw = readConfigEnvKey("ACPX_SUB_AGENT_ROUND_TRIP_CAP");
  if (!raw) return DEFAULT_ROUND_TRIP_CAP;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ROUND_TRIP_CAP;
}

/** The supervisor is ON by default; only the literal "0" disables it. */
function isSupervisorEnabled(): boolean {
  const raw = readConfigEnvKey("ELIZA_ORCHESTRATOR_SUPERVISOR");
  return raw !== "0";
}

type RuntimeWithSend = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId: UuidRoomId },
    content: {
      text: string;
      source: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
};

export class TaskSupervisorService extends Service {
  static serviceType = "ORCHESTRATOR_TASK_SUPERVISOR";

  capabilityDescription =
    "Proactively digests every live orchestrator task into the originating room (change-driven, deduped) and watchdogs stalled / near-cap / over-spend sub-agents.";

  protected override readonly runtime: IAgentRuntime;

  /** Injectable clock so tests can drive staleness deterministically without
   *  real timers. Defaults to wall-clock `Date.now`. */
  now: () => number = () => Date.now();

  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs = readIntervalMs();
  private readonly roundTripCap = readRoundTripCap();
  private readonly spendCapUsd = readSpendCapUsd();
  private started = false;
  private ticking = false;

  /** Last posted digest fingerprint per originating room — the dedup key. */
  private readonly lastDigestFingerprint = new Map<string, string>();
  /** Sessions we have already warned about near-cap / over-spend, so a warning
   *  posts once per session per threshold rather than every tick. */
  private readonly roundTripWarned = new Set<string>();
  private readonly spendWarned = new Set<string>();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.runtime = runtime;
  }

  static async start(runtime: IAgentRuntime): Promise<TaskSupervisorService> {
    const service = new TaskSupervisorService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!isSupervisorEnabled()) {
      this.log(
        "info",
        "supervisor disabled via ELIZA_ORCHESTRATOR_SUPERVISOR=0",
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.runTick().catch((err) =>
        this.log("warn", "supervisor tick failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, this.intervalMs);
    this.timer.unref?.();
    this.log("info", "task supervisor started", {
      intervalMs: this.intervalMs,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.started = false;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  /**
   * One supervisor tick. Public + timer-free so it can be driven directly in
   * tests. Resilient: a single task or session failure is logged and skipped,
   * never aborting the rest of the tick.
   */
  async runTick(): Promise<void> {
    if (this.ticking) return; // never overlap a slow tick with the next timer fire
    this.ticking = true;
    try {
      const taskService = this.taskService();
      if (!taskService) return;

      let threads: Awaited<ReturnType<OrchestratorTaskService["listTasks"]>>;
      try {
        threads = await taskService.listTasks({ includeArchived: false });
      } catch (err) {
        this.log("warn", "listTasks failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Group resolved task details by originating room. One message per room.
      const byRoom = new Map<
        string,
        { source: string; roomId: UuidRoomId; entries: DigestEntry[] }
      >();

      for (const thread of threads) {
        if (!SUPERVISED_STATUSES.has(thread.status)) continue;
        let detail: TaskThreadDetailDto | null;
        try {
          detail = await taskService.getTask(thread.id);
        } catch (err) {
          this.log("warn", "getTask failed", {
            taskId: thread.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (!detail) continue;

        const roomId = detail.taskRoomId ?? detail.roomId;
        if (!isUuidRoom(roomId)) continue;
        const source = this.resolveRoomSource(detail);
        if (!source) continue;

        try {
          await this.watchdogTask(taskService, detail);
        } catch (err) {
          this.log("warn", "watchdog for task failed", {
            taskId: detail.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const entry = this.composeDigestEntry(detail);
        const bucket = byRoom.get(roomId);
        if (bucket) {
          bucket.entries.push(entry);
        } else {
          byRoom.set(roomId, { source, roomId, entries: [entry] });
        }
      }

      for (const { source, roomId, entries } of byRoom.values()) {
        try {
          await this.postRoomDigest(source, roomId, entries);
        } catch (err) {
          this.log("warn", "post room digest failed", {
            roomId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---- digest ------------------------------------------------------------

  private composeDigestEntry(detail: TaskThreadDetailDto): DigestEntry {
    const session = latestSession(detail.sessions);
    const agentType = session?.framework ?? "—";
    // Turn/round count: the running decision count on the active session is the
    // closest structural proxy for "how many round-trips this sub-agent took".
    const roundCount = session?.decisionCount ?? detail.decisionCount ?? 0;
    const lastEvent = latestEvent(detail);
    const lastEventSummary = lastEvent ? truncate(lastEvent.summary, 60) : "—";
    const stale = this.isTaskStale(detail, session);
    return {
      taskId: detail.id,
      label: detail.title || detail.id,
      agentType,
      status: detail.status,
      roundCount,
      lastEventSummary,
      stale,
    };
  }

  /** Time-in-status vs the per-status TTL map. Uses the most recent activity we
   *  can observe (session activity, else the task's updatedAt). */
  private isTaskStale(
    detail: TaskThreadDetailDto,
    session: TaskSessionDto | undefined,
  ): boolean {
    const ttl = STATUS_STALE_TTL_MS[detail.status];
    if (!ttl) return false;
    const lastActivityAt =
      session?.lastActivityAt ??
      detail.latestActivityAt ??
      Date.parse(detail.updatedAt);
    if (!Number.isFinite(lastActivityAt)) return false;
    return this.now() - lastActivityAt > ttl;
  }

  private formatDigestLine(entry: DigestEntry): string {
    const emoji = statusEmoji(entry.status);
    const staleMark = entry.stale ? " ⚠️stale" : "";
    return `${emoji} [${entry.label}] ${entry.agentType} · ${entry.status} · ${entry.roundCount} rounds · ${entry.lastEventSummary}${staleMark}`;
  }

  /**
   * Build the room digest message text and post it — but only when its content
   * fingerprint changed since the last post for this room. Unchanged → no post
   * (the anti-spam guarantee).
   */
  private async postRoomDigest(
    source: string,
    roomId: UuidRoomId,
    entries: DigestEntry[],
  ): Promise<void> {
    // Deterministic order so the fingerprint is stable turn-over-turn.
    entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
    const lines = entries.map((entry) => this.formatDigestLine(entry));
    const body = lines.join("\n");
    const fingerprint = createHash("sha1").update(body).digest("hex");

    if (this.lastDigestFingerprint.get(roomId) === fingerprint) {
      return; // unchanged — stay silent
    }
    this.lastDigestFingerprint.set(roomId, fingerprint);

    const text = `📋 Task digest (${entries.length} live)\n${body}`;
    await this.sendToRoom(source, roomId, text);
  }

  // ---- watchdog (#8901) --------------------------------------------------

  private async watchdogTask(
    taskService: OrchestratorTaskService,
    detail: TaskThreadDetailDto,
  ): Promise<void> {
    const roomId = detail.taskRoomId ?? detail.roomId;
    const source = this.resolveRoomSource(detail);
    for (const session of detail.sessions) {
      if (TERMINAL_SESSION_STATUSES.has(session.status)) continue;
      try {
        await this.watchdogSession(
          taskService,
          detail,
          session,
          isUuidRoom(roomId) ? roomId : undefined,
          source,
        );
      } catch (err) {
        this.log("warn", "watchdog session failed", {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async watchdogSession(
    taskService: OrchestratorTaskService,
    detail: TaskThreadDetailDto,
    session: TaskSessionDto,
    roomId: UuidRoomId | undefined,
    source: string | undefined,
  ): Promise<void> {
    // ── stall detection: no event/tool update for DEFAULT_STALL_TTL_MS ──
    const lastEventAt = session.lastActivityAt;
    const stalled =
      Number.isFinite(lastEventAt) &&
      this.now() - lastEventAt > DEFAULT_STALL_TTL_MS;

    // Persist the structural flag on the ACP session metadata so the cache-
    // stable ACTIVE_SUB_AGENTS provider reads it without computing time. Only
    // write on a change to avoid churn.
    await this.persistStalledFlag(session.sessionId, stalled);

    if (stalled) {
      try {
        await taskService.sendToTaskAgent(
          detail.id,
          session.sessionId,
          GRILL_PROMPT,
          "watchdog_grill",
        );
        this.log("info", "grilled stalled sub-agent", {
          sessionId: session.sessionId,
          taskId: detail.id,
        });
      } catch (err) {
        this.log("warn", "grill send failed", {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── round-trip cap proximity warning ──
    const roundCount = session.decisionCount;
    if (
      roundCount >= this.roundTripCap - ROUND_TRIP_WARN_MARGIN &&
      !this.roundTripWarned.has(session.sessionId)
    ) {
      this.roundTripWarned.add(session.sessionId);
      if (roomId && source) {
        await this.sendToRoom(
          source,
          roomId,
          `⚠️ [${session.label}] is at ${roundCount}/${this.roundTripCap} round-trips and will be force-stopped near the cap. Consider intervening.`,
        );
      }
    }

    // ── spend > 80% of cap warning ──
    if (this.spendCapUsd > 0) {
      const spent = getSessionSpendUsd(session.sessionId);
      if (
        spent >= this.spendCapUsd * SPEND_WARN_FRACTION &&
        !this.spendWarned.has(session.sessionId)
      ) {
        this.spendWarned.add(session.sessionId);
        if (roomId && source) {
          await this.sendToRoom(
            source,
            roomId,
            `⚠️ [${session.label}] has spent $${spent.toFixed(2)} of its $${this.spendCapUsd.toFixed(2)} budget (>${Math.round(SPEND_WARN_FRACTION * 100)}%).`,
          );
        }
      }
    }
  }

  /** Set / clear the `stalled` boolean on the live ACP session metadata. The
   *  ACTIVE_SUB_AGENTS provider reads this structural flag directly. */
  private async persistStalledFlag(
    sessionId: string,
    stalled: boolean,
  ): Promise<void> {
    const acp = this.acp();
    if (!acp) return;
    try {
      const session = await acp.getSession(sessionId);
      if (!session) return;
      const current = Boolean(
        (session.metadata as Record<string, unknown> | undefined)?.stalled,
      );
      if (current === stalled) return; // no churn on unchanged flag
      await acp.updateSessionMetadata(sessionId, { stalled });
    } catch (err) {
      this.log("debug", "persist stalled flag failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- helpers -----------------------------------------------------------

  /**
   * Resolve the connector source for a task room. The origin source is recorded
   * on the task metadata (mirrors how the sub-agent router reads `metadata.source`
   * off the spawning session). Falls back to the single registered connector
   * when unambiguous, else undefined (we never guess wrong across connectors).
   */
  private resolveRoomSource(detail: TaskThreadDetailDto): string | undefined {
    const fromMeta: unknown =
      detail.metadata?.source ?? detail.metadata?.originSource;
    if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
    const connectors = this.runtime.getMessageConnectors?.();
    if (Array.isArray(connectors) && connectors.length === 1) {
      const only = connectors[0];
      if (only && typeof only.source === "string") return only.source;
    }
    return undefined;
  }

  private async sendToRoom(
    source: string,
    roomId: UuidRoomId,
    text: string,
  ): Promise<void> {
    const send = (this.runtime as RuntimeWithSend).sendMessageToTarget;
    if (typeof send !== "function") {
      this.log("warn", "sendMessageToTarget unavailable; digest dropped", {
        roomId,
      });
      return;
    }
    // Mark as a transient internal post: tag it so the orchestrator's
    // sendMessageToTarget thread-redirect wrapper treats it as a first-class
    // user-facing send (it is NOT in the wrapper's internal-source skip set, so
    // it benefits from per-task thread redirection like any planner reply).
    await send(
      { source, roomId },
      {
        text,
        source: "task_supervisor",
        metadata: { transient: true },
      },
    );
  }

  private taskService(): OrchestratorTaskService | undefined {
    return (
      this.runtime.getService<OrchestratorTaskService>(
        OrchestratorTaskService.serviceType,
      ) ?? undefined
    );
  }

  private acp(): AcpService | undefined {
    return (
      this.runtime.getService<AcpService>(AcpService.serviceType) ?? undefined
    );
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const logger = this.runtime.logger;
    const fn = logger?.[level];
    if (typeof fn === "function") {
      fn.call(
        logger,
        { src: "acpx:task-supervisor", ...(data ?? {}) },
        `[TaskSupervisorService] ${message}`,
      );
    }
  }
}

/** The grill the watchdog auto-sends to a stalled sub-agent. */
export const GRILL_PROMPT =
  "Are you still working? What is your current status, and what is blocking you? If you are done, report completion with proof.";

function latestSession(
  sessions: readonly TaskSessionDto[],
): TaskSessionDto | undefined {
  let latest: TaskSessionDto | undefined;
  for (const session of sessions) {
    if (TERMINAL_SESSION_STATUSES.has(session.status)) continue;
    if (!latest || session.lastActivityAt > latest.lastActivityAt) {
      latest = session;
    }
  }
  // Fall back to the most recent of any session when no live one exists.
  if (!latest) {
    for (const session of sessions) {
      if (!latest || session.lastActivityAt > latest.lastActivityAt) {
        latest = session;
      }
    }
  }
  return latest;
}

function latestEvent(
  detail: TaskThreadDetailDto,
): TaskThreadDetailDto["events"][number] | undefined {
  let latest: TaskThreadDetailDto["events"][number] | undefined;
  for (const event of detail.events) {
    if (!latest || event.timestamp > latest.timestamp) latest = event;
  }
  return latest;
}
