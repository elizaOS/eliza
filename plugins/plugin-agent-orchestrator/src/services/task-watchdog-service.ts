/**
 * TaskWatchdogService — stalled-sub-agent detection + auto-grill, plus
 * approaching-cap warnings (#8901, EPIC #8885).
 *
 * No monitor today notices a sub-agent that has gone silent (no tool call / no
 * snapshot update), or one that is quietly burning toward its runaway-loop /
 * spend cap. This service ticks on an interval and does two best-effort things:
 *
 *   1. **Idle stall** — finds active sessions whose last activity is older than a
 *      threshold and prods each ONCE with a status-check prompt ("are you still
 *      working? what's blocking you?").
 *   2. **Approaching cap** — finds active sessions whose round-trip count or
 *      self-spend has crossed a warn ratio (default 80%) of its cap, and posts a
 *      ONE-TIME warning to the originating chat room so the user/planner can stop
 *      or redirect the session before the loop guard force-stops it.
 *
 * Both detections are pure functions (`detectStalledSessions`,
 * `detectCapWarnings`) so they unit-test without timers or a runtime. The stalled
 * set and the approaching-cap set are exposed so the ACTIVE_SUB_AGENTS provider
 * can surface both.
 */

import type { Content, IAgentRuntime, UUID } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { getSessionSpendUsd, readSpendCapUsd } from "./spend-allowance.js";
import { TERMINAL_SESSION_STATUSES } from "./types.js";

export const TASK_WATCHDOG_SERVICE_TYPE = "ORCHESTRATOR_TASK_WATCHDOG";

/** The prompt sent to a stalled sub-agent to prod it back to life. */
export const STALL_GRILL_PROMPT =
  "Status check: you've gone quiet. Are you still working? Report your current status, what you've completed, and exactly what (if anything) is blocking you. If you're done, summarize the result.";

const DEFAULT_STALL_MS = 180_000; // 3 minutes of no activity
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
/** Warn once a session crosses this fraction of a round-trip / spend cap. */
const DEFAULT_CAP_WARN_RATIO = 0.8;

/** Minimal session shape the idle detector needs. */
export interface WatchdogSessionView {
  id: string;
  status: string;
  /** Epoch ms of last activity (tool call / snapshot / event). */
  lastActivityMs: number;
}

export interface StalledSession {
  id: string;
  idleMs: number;
}

/**
 * Pure: which active (non-terminal) sessions have been idle longer than
 * `stallMs` as of `nowMs`. Terminal sessions are never "stalled" — they're done.
 */
export function detectStalledSessions(
  sessions: WatchdogSessionView[],
  nowMs: number,
  stallMs: number,
): StalledSession[] {
  const stalled: StalledSession[] = [];
  for (const s of sessions) {
    if (TERMINAL_SESSION_STATUSES.has(s.status)) continue;
    const idleMs = nowMs - s.lastActivityMs;
    if (idleMs >= stallMs) stalled.push({ id: s.id, idleMs });
  }
  return stalled;
}

export type CapWarningKind = "round-trip" | "spend";

/** Minimal session shape the cap detector needs. A cap field pair is omitted
 * when that signal is unavailable (no router bound, or spend allowance off). */
export interface CapWarningView {
  id: string;
  status: string;
  roundTripCount?: number;
  roundTripCap?: number;
  spendUsd?: number;
  spendCapUsd?: number;
}

export interface CapWarning {
  id: string;
  kind: CapWarningKind;
  /** `count / limit` (≥ `warnRatio`, < 1 until the cap is actually hit). */
  ratio: number;
  /** Round-trips taken, or USD spent. */
  count: number;
  /** The round-trip cap, or the spend cap (USD). */
  limit: number;
}

/**
 * Pure: which active (non-terminal) sessions have crossed `warnRatio` of their
 * round-trip cap or spend cap. A signal is only evaluated when both its cap (> 0)
 * and current value are present — a missing cap (spend allowance disabled, or no
 * router bound) yields no warning, never a false positive.
 */
export function detectCapWarnings(
  views: CapWarningView[],
  warnRatio: number,
): CapWarning[] {
  const warnings: CapWarning[] = [];
  for (const v of views) {
    if (TERMINAL_SESSION_STATUSES.has(v.status)) continue;
    if (
      typeof v.roundTripCap === "number" &&
      v.roundTripCap > 0 &&
      typeof v.roundTripCount === "number"
    ) {
      const ratio = v.roundTripCount / v.roundTripCap;
      if (ratio >= warnRatio) {
        warnings.push({
          id: v.id,
          kind: "round-trip",
          ratio,
          count: v.roundTripCount,
          limit: v.roundTripCap,
        });
      }
    }
    if (
      typeof v.spendCapUsd === "number" &&
      v.spendCapUsd > 0 &&
      typeof v.spendUsd === "number" &&
      v.spendUsd > 0
    ) {
      const ratio = v.spendUsd / v.spendCapUsd;
      if (ratio >= warnRatio) {
        warnings.push({
          id: v.id,
          kind: "spend",
          ratio,
          count: v.spendUsd,
          limit: v.spendCapUsd,
        });
      }
    }
  }
  return warnings;
}

/** The originating chat target, resolved from a session's spawn metadata —
 * the same `roomId`/`source` keys the SubAgentRouter routes completions to. */
function resolveOrigin(
  metadata: Record<string, unknown> | undefined,
): { roomId: UUID; source: string } | null {
  const roomId = metadata?.roomId;
  if (typeof roomId !== "string" || roomId.length === 0) return null;
  const source =
    typeof metadata?.source === "string" && metadata.source
      ? metadata.source
      : "orchestrator";
  return { roomId: roomId as UUID, source };
}

function sessionLabel(metadata: Record<string, unknown> | undefined): string {
  const label = metadata?.label;
  return typeof label === "string" && label.trim() ? label : "A sub-agent";
}

/** Deterministic warning text for the originating room. */
export function composeCapWarning(warning: CapWarning, label: string): string {
  const pct = Math.round(warning.ratio * 100);
  if (warning.kind === "round-trip") {
    return `⚠️ ${label} is at ${warning.count}/${warning.limit} round-trips (${pct}%) — risk of a runaway loop. Consider stopping it (STOP_AGENT) or redirecting it (SEND_TO_AGENT) before it force-stops.`;
  }
  return `⚠️ ${label} has spent $${warning.count.toFixed(2)} of its $${warning.limit.toFixed(2)} budget (${pct}%) — approaching the spend cap. Consider stopping or redirecting it.`;
}

interface AcpServiceLike {
  listSessions(): Promise<
    Array<{
      id: string;
      status: string;
      lastActivityAt: Date;
      metadata?: Record<string, unknown>;
    }>
  >;
  sendToSession(sessionId: string, input: string): Promise<unknown>;
}

/** Read-only round-trip accounting exposed by the SubAgentRouter. */
interface RoundTripCapSource {
  getRoundTripCount(sessionId: string): number;
  getRoundTripCap(): number;
}

type RuntimeWithSendTarget = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID; accountId?: string },
    content: Content,
  ) => Promise<unknown>;
};

export class TaskWatchdogService extends Service {
  static serviceType = TASK_WATCHDOG_SERVICE_TYPE;
  capabilityDescription =
    "Detects stalled (idle) sub-agent sessions and prods them, and warns the originating room when a session approaches its round-trip or spend cap.";

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Session ids already prodded this stall, so we grill once (not every tick). */
  private readonly prodded = new Set<string>();
  /** `${kind}:${sessionId}` already warned this approach, so we warn once per
   * threshold crossing (cleared when the ratio drops back under the threshold). */
  private readonly warned = new Set<string>();

  static async start(runtime: IAgentRuntime): Promise<TaskWatchdogService> {
    const svc = new TaskWatchdogService(runtime);
    if (svc.enabled()) svc.startTimer();
    return svc;
  }

  private enabled(): boolean {
    return this.runtime.getSetting("ELIZA_ORCHESTRATOR_WATCHDOG") !== "0";
  }

  private stallMs(): number {
    const raw = this.runtime.getSetting("ELIZA_ORCHESTRATOR_STALL_MS");
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? n : DEFAULT_STALL_MS;
  }

  private warnRatio(): number {
    const raw = this.runtime.getSetting("ELIZA_ORCHESTRATOR_CAP_WARN_RATIO");
    const n = typeof raw === "string" ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_CAP_WARN_RATIO;
  }

  private intervalMs(): number {
    const raw = this.runtime.getSetting(
      "ELIZA_ORCHESTRATOR_WATCHDOG_INTERVAL_MS",
    );
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? n : DEFAULT_INTERVAL_MS;
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs());
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Session ids currently considered stalled (for the ACTIVE_SUB_AGENTS provider). */
  getStalledSessionIds(): string[] {
    return [...this.prodded];
  }

  /** Sessions currently approaching a cap (for the ACTIVE_SUB_AGENTS provider). */
  getApproachingCapSessionIds(): Array<{ id: string; kind: CapWarningKind }> {
    return [...this.warned].map((key) => {
      const sep = key.indexOf(":");
      return {
        id: key.slice(sep + 1),
        kind: key.slice(0, sep) as CapWarningKind,
      };
    });
  }

  async runOnce(nowMs = Date.now()): Promise<StalledSession[]> {
    const acp = this.runtime.getService<Service & AcpServiceLike>(
      "ACP_SUBPROCESS_SERVICE",
    );
    if (!acp) return [];
    const sessions = await acp.listSessions();
    const views: WatchdogSessionView[] = sessions.map((s) => ({
      id: s.id,
      status: s.status,
      lastActivityMs: s.lastActivityAt?.getTime?.() ?? 0,
    }));
    const stalled = detectStalledSessions(views, nowMs, this.stallMs());
    const stalledIds = new Set(stalled.map((s) => s.id));

    // Clear the prodded flag for sessions that recovered or ended, so a future
    // stall re-grills.
    for (const id of [...this.prodded]) {
      if (!stalledIds.has(id)) this.prodded.delete(id);
    }

    for (const s of stalled) {
      if (this.prodded.has(s.id)) continue; // already prodded this stall
      this.prodded.add(s.id);
      try {
        await acp.sendToSession(s.id, STALL_GRILL_PROMPT);
        logger.info(
          `[TaskWatchdogService] stalled session ${s.id} (idle ${Math.round(
            s.idleMs / 1000,
          )}s) — prodding`,
        );
      } catch (error) {
        // error-policy:J7 watchdog loop must survive a single failed prod; the failure is warned and retried next tick
        // Prod failed; un-mark so the next tick retries.
        this.prodded.delete(s.id);
        logger.warn(
          `[TaskWatchdogService] failed to prod stalled session ${s.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.checkCapWarnings(sessions);
    return stalled;
  }

  /**
   * Detect sessions approaching their round-trip / spend cap and post a one-time
   * warning to each origin room. Best-effort and non-fatal — when no signal
   * source is available (router not yet bound, spend allowance off) it no-ops.
   */
  private async checkCapWarnings(
    sessions: Array<{
      id: string;
      status: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const router = this.runtime.getService<Service & RoundTripCapSource>(
      "ACPX_SUB_AGENT_ROUTER",
    );
    const spendCapUsd = readSpendCapUsd();
    if (!router && !(spendCapUsd > 0)) {
      // No cap signal available this tick — nothing to evaluate. Drop any stale
      // warned entries so a subsequent signal re-warns cleanly.
      this.warned.clear();
      return;
    }

    const roundTripCap = router?.getRoundTripCap();
    const views: CapWarningView[] = sessions.map((s) => ({
      id: s.id,
      status: s.status,
      ...(router
        ? { roundTripCount: router.getRoundTripCount(s.id), roundTripCap }
        : {}),
      ...(spendCapUsd > 0
        ? { spendUsd: getSessionSpendUsd(s.id), spendCapUsd }
        : {}),
    }));
    const warnings = detectCapWarnings(views, this.warnRatio());
    const activeKeys = new Set(warnings.map((w) => `${w.kind}:${w.id}`));

    // Recover-then-rewarn: drop a (session,kind) that fell back under threshold
    // so a subsequent climb re-warns (mirrors the idle `prodded` dedup).
    for (const key of [...this.warned]) {
      if (!activeKeys.has(key)) this.warned.delete(key);
    }

    const metaById = new Map(sessions.map((s) => [s.id, s.metadata]));
    for (const warning of warnings) {
      const key = `${warning.kind}:${warning.id}`;
      if (this.warned.has(key)) continue; // already warned this approach
      this.warned.add(key);
      try {
        await this.postCapWarning(warning, metaById.get(warning.id));
      } catch (error) {
        // error-policy:J7 watchdog loop must survive a single failed warning delivery; the failure is warned and retried next tick
        // Delivery failed; un-mark so the next tick retries.
        this.warned.delete(key);
        logger.warn(
          `[TaskWatchdogService] failed to warn origin room for session ${warning.id} (${warning.kind}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async postCapWarning(
    warning: CapWarning,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    const send = (this.runtime as RuntimeWithSendTarget).sendMessageToTarget;
    if (typeof send !== "function") return;
    const origin = resolveOrigin(metadata);
    if (!origin) return; // no chat origin — nothing to warn into
    const text = composeCapWarning(warning, sessionLabel(metadata));
    await send(
      { source: origin.source, roomId: origin.roomId },
      { text, source: origin.source },
    );
    logger.info(
      `[TaskWatchdogService] session ${warning.id} approaching ${warning.kind} cap (${warning.count}/${warning.limit}, ${Math.round(
        warning.ratio * 100,
      )}%) — warning room ${origin.roomId}`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.prodded.clear();
    this.warned.clear();
  }
}
