/**
 * TaskWatchdogService — stalled-sub-agent detection + auto-grill (#8901, EPIC #8885).
 *
 * No monitor today notices a sub-agent that has gone silent (no tool call / no
 * snapshot update). This service ticks on an interval, finds active sessions
 * whose last activity is older than a threshold, and prods each ONCE with a
 * status-check prompt ("are you still working? what's blocking you?"). The
 * stalled set is exposed so the ACTIVE_SUB_AGENTS provider can surface it.
 *
 * The detection is a pure function (`detectStalledSessions`) so it unit-tests
 * without timers or a runtime.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { TERMINAL_SESSION_STATUSES } from "./types.js";

export const TASK_WATCHDOG_SERVICE_TYPE = "ORCHESTRATOR_TASK_WATCHDOG";

/** The prompt sent to a stalled sub-agent to prod it back to life. */
export const STALL_GRILL_PROMPT =
  "Status check: you've gone quiet. Are you still working? Report your current status, what you've completed, and exactly what (if anything) is blocking you. If you're done, summarize the result.";

const DEFAULT_STALL_MS = 180_000; // 3 minutes of no activity
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;

/** Minimal session shape the detector needs. */
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

interface AcpServiceLike {
  listSessions(): Promise<
    Array<{ id: string; status: string; lastActivityAt: Date }>
  >;
  sendToSession(sessionId: string, input: string): Promise<unknown>;
}

export class TaskWatchdogService extends Service {
  static serviceType = TASK_WATCHDOG_SERVICE_TYPE;
  capabilityDescription =
    "Detects stalled (idle) sub-agent sessions and prods them with a status-check prompt.";

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Session ids already prodded this stall, so we grill once (not every tick). */
  private readonly prodded = new Set<string>();

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
        // Prod failed; un-mark so the next tick retries.
        this.prodded.delete(s.id);
        logger.warn(
          `[TaskWatchdogService] failed to prod stalled session ${s.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return stalled;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.prodded.clear();
  }
}
