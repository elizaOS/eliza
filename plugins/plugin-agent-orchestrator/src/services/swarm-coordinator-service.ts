/**
 * @module services/swarm-coordinator-service
 *
 * SWARM_COORDINATOR service: the discoverable runtime adapter that bridges the
 * orchestrator's `AcpService` session-event stream to the consumers that still
 * speak the legacy "swarm coordinator" interface.
 *
 * ## Why this exists
 *
 * The `plugin-acpx` + `plugin-agent-orchestrator` consolidation
 * (`dc1b89c2eb`) deleted `pty-service.ts` and `swarm-coordinator.ts`. The old
 * `PtyService.start()` constructed a `SwarmCoordinator`, started it, and
 * registered it on the runtime under `SWARM_COORDINATOR`. With those files
 * gone, NOTHING registers a `SWARM_COORDINATOR` service anymore — but three
 * consumers were never migrated and still discover it via
 * `runtime.getService("SWARM_COORDINATOR")` (or `PTY_SERVICE.coordinator`):
 *
 *   1. `packages/agent/src/api/coordinator-wiring.ts`
 *      (`wireCoordinatorBridgesWhenReady`) polls for the service for 90s and,
 *      when it never appears, logs
 *      `coordinator not available after 90s — coding agent features disabled`
 *      and leaves the chat / ws / event-routing / swarm-synthesis bridges
 *      unwired.
 *   2. `packages/agent/src/api/server-helpers-swarm.ts`
 *      (`getCoordinatorFromRuntime`, the `wireCodingAgent*Bridge` helpers)
 *      look up the same service and expect the
 *      `setChatCallback` / `setWsBroadcast` / `setAgentDecisionCallback` /
 *      `setSwarmCompleteCallback` / `getTaskThread` / `sourceRoomId` surface.
 *   3. `plugins/plugin-app-control/src/services/verification-room-bridge.ts`
 *      needs `subscribe(listener)` so it can post verification verdicts back
 *      into the originating chat room. Without it, it logs
 *      `SWARM_COORDINATOR service still has no subscribe() after 60 retries;
 *      bridge inactive.`
 *
 * This service restores the registration + the exact surface those consumers
 * depend on, implemented as a thin adapter over the post-consolidation
 * `AcpService` event bus (no resurrection of the deleted 2600-line coordinator
 * or its `TaskRegistry` / pty internals).
 *
 * ## Event mapping
 *
 * `AcpService.onSessionEvent(sessionId, eventName, data)` is re-shaped to the
 * legacy `SwarmEvent` (`{ type, sessionId, timestamp, data }`) and fanned out
 * to every `subscribe()` listener AND to the injected `setWsBroadcast`
 * callback. The chat / agent-decision / swarm-complete callbacks are stored and
 * invoked from the points where the orchestrator already has the matching data
 * (terminal session events trigger swarm-complete synthesis).
 *
 * The setters being present + returning a live coordinator is what makes
 * `wireChatBridge` / `wireWsBridge` / `wireEventRouting` / `wireSwarmSynthesis`
 * each return `true`, so `wireCoordinatorBridgesWhenReady` succeeds on boot
 * instead of timing out.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import { OrchestratorTaskService } from "./orchestrator-task-service.js";
import { sanitizeCompletionRelay } from "./transcript-sanitizer.js";
import { TERMINAL_SESSION_STATUSES } from "./types.js";

export const SWARM_COORDINATOR_SERVICE_TYPE = "SWARM_COORDINATOR";

/** Legacy swarm event shape consumed by the bridges. */
export interface SwarmEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  data: unknown;
}

export type SwarmEventListener = (event: SwarmEvent) => void;

export type ChatMessageCallback = (
  text: string,
  source?: string,
  routing?: {
    sessionId?: string;
    threadId?: string;
    roomId?: string | null;
  },
) => Promise<void>;

export type WsBroadcastCallback = (event: SwarmEvent) => void;

export interface TaskContextLike {
  threadId: string;
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  [key: string]: unknown;
}

export type AgentDecisionCallback = (
  eventDescription: string,
  sessionId: string,
  taskContext: TaskContextLike,
) => Promise<unknown | null>;

export interface TaskCompletionSummary {
  sessionId: string;
  label: string;
  agentType: string;
  originalTask: string;
  status: string;
  completionSummary: string;
  workdir?: string;
  roomId?: string | null;
  replyToExternalMessageId?: string | null;
  [key: string]: unknown;
}

export type SwarmCompleteCallback = (payload: {
  tasks: TaskCompletionSummary[];
  total: number;
  completed: number;
  stopped: number;
  errored: number;
}) => Promise<void>;

interface LegacyCoordinatorTask {
  sessionId: string;
  label?: string;
  threadId?: string;
  status: string;
  agentType?: string;
  originalTask?: string;
  workdir?: string;
  originMetadata?: {
    messageId?: string;
    roomId?: string;
    replyToExternalMessageId?: string;
  };
}

interface EnrichmentMetadata {
  metadata: Record<string, unknown>;
  workdir?: string;
  agentType?: string;
}

const STREAMING_SESSION_EVENTS = new Set(["message", "reasoning", "plan"]);

const LEGACY_TASK_EVICTION_GRACE_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

export class SwarmCoordinatorService extends Service {
  static override serviceType = SWARM_COORDINATOR_SERVICE_TYPE;

  override capabilityDescription =
    "Bridges the orchestrator's ACP session-event stream to the legacy swarm-coordinator surface (subscribe + chat / ws / agent-decision / swarm-complete callbacks) so the server's coordinator bridges and the verification-room-bridge wire on boot.";

  private readonly listeners = new Set<SwarmEventListener>();
  private chatCallback: ChatMessageCallback | null = null;
  private wsBroadcast: WsBroadcastCallback | null = null;
  private agentDecisionCallback: AgentDecisionCallback | null = null;
  private swarmCompleteCallback: SwarmCompleteCallback | null = null;
  private readonly inFlightDecisionSessions = new Set<string>();
  private readonly synthesizedCompletionSessions = new Set<string>();
  private readonly enrichmentMetadataCache = new Map<
    string,
    EnrichmentMetadata
  >();
  private readonly legacyTaskEvictionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Legacy coordinator surface consumed by Discord timeout suppression and
   * task-agent connector routing. Keep this as a real, live Map while the
   * post-consolidation ACP service remains the source of truth.
   */
  readonly tasks = new Map<string, LegacyCoordinatorTask>();

  private unsubscribeAcp: (() => void) | null = null;
  private acpBindAttempts = 0;
  private acpBindTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /**
   * Observable bind state so the readiness probe (coordinator-wiring.ts) and
   * status route can report WHY supervision is degraded — a bound coordinator
   * whose ACP stream never connected looks identical, from the outside, to a
   * healthy one (the service object exists either way). Consumers read
   * {@link acpBindState} instead of inferring liveness from `getService()`.
   *
   *  - `pending`   : bind in flight (event-driven wait + polling fallback).
   *  - `bound`     : subscribed to the ACP session-event stream; events flow.
   *  - `unbound`   : ACP service failed to start / rejected; stream inactive.
   */
  private acpBindStatus: "pending" | "bound" | "unbound" = "pending";
  /** Last actionable reason the bind is not `bound` (for the readiness probe). */
  private acpBindReason: string | null = null;
  /** Set once the event-driven load-promise wait has been armed (arm-once). */
  private acpLoadWaitArmed = false;

  /**
   * The room id that out-of-band synthesis routing falls back to. Declared on
   * the interface the bridges read; the orchestrator routes per-task room ids
   * through the completion payload instead, so this stays null and the bridges
   * use their own per-task fallback. Kept for interface compatibility.
   */
  sourceRoomId: string | null = null;

  /**
   * Readiness view for third-party probes. `bound` means the ACP session-event
   * stream is live and supervision works; anything else carries an actionable
   * `reason`. Coordinator-wiring reads this so the 90s probe can distinguish
   * "plugin missing" from "bind timed out" instead of reporting a generic
   * "coordinator not available".
   */
  get acpBindState(): {
    status: "pending" | "bound" | "unbound";
    reason: string | null;
    attempts: number;
  } {
    return {
      status: this.acpBindStatus,
      reason: this.acpBindReason,
      attempts: this.acpBindAttempts,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<SwarmCoordinatorService> {
    const service = new SwarmCoordinatorService(runtime);
    service.bindToAcp();
    return service;
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.acpBindTimer) {
      clearTimeout(this.acpBindTimer);
      this.acpBindTimer = null;
    }
    const unsub = this.unsubscribeAcp;
    this.unsubscribeAcp = null;
    if (typeof unsub === "function") {
      try {
        unsub();
      } catch (err) {
        logger.warn(
          `[SwarmCoordinator] AcpService unsubscribe threw during stop(): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.listeners.clear();
    this.chatCallback = null;
    this.wsBroadcast = null;
    this.agentDecisionCallback = null;
    this.swarmCompleteCallback = null;
    this.inFlightDecisionSessions.clear();
    this.synthesizedCompletionSessions.clear();
    this.enrichmentMetadataCache.clear();
    for (const timer of this.legacyTaskEvictionTimers.values()) {
      clearTimeout(timer);
    }
    this.legacyTaskEvictionTimers.clear();
    this.tasks.clear();
    // The event-driven load-promise wait can't be cancelled, but `stopped`
    // guards its continuation; reset the arm flag so a restarted instance
    // re-arms cleanly.
    this.acpLoadWaitArmed = false;
    if (this.acpBindStatus === "pending") {
      this.acpBindStatus = "unbound";
      this.acpBindReason = "service stopped before ACP bind completed";
    }
  }

  // ── subscribe() — the surface verification-room-bridge depends on ──────────

  /**
   * Register a listener for the in-process swarm event stream. Returns an
   * unsubscribe function. Every AcpService session event is re-shaped to a
   * {@link SwarmEvent} and delivered to every listener.
   */
  subscribe(listener: SwarmEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── server-helpers-swarm.ts callback setters ───────────────────────────────

  setChatCallback(cb: ChatMessageCallback): void {
    this.chatCallback = cb;
  }

  setWsBroadcast(cb: WsBroadcastCallback): void {
    this.wsBroadcast = cb;
  }

  setAgentDecisionCallback(cb: AgentDecisionCallback): void {
    this.agentDecisionCallback = cb;
  }

  /** Compatibility helper retained from the deleted coordinator surface. */
  getAgentDecisionCallback(): AgentDecisionCallback | null {
    return this.agentDecisionCallback;
  }

  /** Compatibility helper retained from the deleted coordinator surface. */
  async sendChatMessage(
    text: string,
    source?: string,
    routing?: {
      sessionId?: string;
      threadId?: string;
      roomId?: string | null;
    },
  ): Promise<boolean> {
    if (!this.chatCallback) return false;
    await this.chatCallback(text, source, routing);
    return true;
  }

  setSwarmCompleteCallback(cb: SwarmCompleteCallback): void {
    this.swarmCompleteCallback = cb;
  }

  /** Compatibility helper retained from the deleted coordinator surface. */
  getSwarmCompleteCallback(): SwarmCompleteCallback | null {
    return this.swarmCompleteCallback;
  }

  getTaskContext(sessionId: string): LegacyCoordinatorTask | null {
    return this.tasks.get(sessionId) ?? null;
  }

  getAllTaskContexts(): LegacyCoordinatorTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Resolve the originating chat room for a task thread, so the connector-route
   * fallback in server-helpers-swarm can target the right room. Delegates to
   * the OrchestratorTaskService task-origin resolver.
   */
  async getTaskThread(
    threadId: string,
  ): Promise<{ roomId?: string | null } | null> {
    const taskService =
      this.runtime.getService<OrchestratorTaskService>(
        OrchestratorTaskService.serviceType,
      ) ?? null;
    if (!taskService) return null;
    try {
      const origin = await taskService.getTaskOriginTarget(threadId);
      return origin ? { roomId: origin.roomId } : null;
    } catch {
      return null;
    }
  }

  // ── AcpService event bridge ────────────────────────────────────────────────

  private acp(): AcpService | null {
    return this.runtime.getService<AcpService>(AcpService.serviceType) ?? null;
  }

  /**
   * Subscribe to the AcpService session-event stream.
   *
   * Service start order at boot is not deterministic and ACP startup can take
   * well over a minute on a heavy boot (big character, many plugins, embedding
   * warmup). Binding therefore uses two complementary mechanisms:
   *
   *   1. **Event-driven** — `runtime.getServiceLoadPromise(ACP)` resolves the
   *      instant ACP finishes starting, however long that takes. This is the
   *      primary path: no fixed deadline, so it can't "give up" before a slow
   *      boot finishes. It resolves/rejects exactly once.
   *   2. **Polling fallback** — a short interval re-checks `getService(ACP)` in
   *      case the load-promise is unavailable or the service was registered by
   *      a path that doesn't drive it. Unlike the old bounded 60s loop, this
   *      fallback is UNBOUNDED but backs off and ESCALATES log severity, so a
   *      genuinely stuck bind is loud (error) instead of silent.
   *
   * The prior implementation polled for a fixed 60s then gave up with a single
   * warn, leaving `acpBindTimer=null` and never re-arming. On a boot where ACP
   * registered at, say, 70s, the coordinator went permanently inert while the
   * service object still existed — so the 90s wiring probe "succeeded" and set
   * its callbacks, but no ACP events ever reached them (supervision degraded,
   * silently). This fix closes that race.
   */
  private bindToAcp(): void {
    if (this.stopped || this.unsubscribeAcp) return;

    // Arm the event-driven wait exactly once. This is the real fix: it can't
    // time out before ACP starts, however slow the boot.
    this.armAcpLoadWait();

    const acp = this.acp();
    if (!acp) {
      // ACP not registered yet — keep the polling fallback ticking. The
      // load-promise above will normally win the race, but the poll survives
      // the case where it isn't wired.
      this.scheduleAcpBindRetry();
      return;
    }
    this.completeBind(acp);
  }

  /**
   * Event-driven bind: await the ACP service load-promise, which resolves as
   * soon as ACP finishes starting (no fixed deadline). Armed once; the polling
   * fallback races it and whichever wins calls {@link completeBind} (guarded by
   * `unsubscribeAcp` so the second is a no-op).
   */
  private armAcpLoadWait(): void {
    if (this.acpLoadWaitArmed || this.stopped) return;
    const loadPromise = this.runtime.getServiceLoadPromise?.(
      AcpService.serviceType,
    );
    if (!loadPromise || typeof loadPromise.then !== "function") {
      // Runtime doesn't expose the load-promise — rely on the polling fallback.
      return;
    }
    this.acpLoadWaitArmed = true;
    void loadPromise.then(
      (svc) => {
        if (this.stopped || this.unsubscribeAcp) return;
        const acp =
          (svc as AcpService | undefined) &&
          typeof (svc as AcpService).onSessionEvent === "function"
            ? (svc as AcpService)
            : this.acp();
        if (acp) this.completeBind(acp);
      },
      (err: unknown) => {
        // ACP failed to start. This is terminal: the polling fallback would
        // spin forever, so mark unbound LOUDLY with the actionable reason.
        if (this.stopped || this.unsubscribeAcp) return;
        this.markUnbound(
          `AcpService failed to start: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }

  /** Subscribe to the resolved ACP instance. Idempotent via `unsubscribeAcp`. */
  private completeBind(acp: AcpService): void {
    if (this.stopped || this.unsubscribeAcp) return;
    if (this.acpBindTimer) {
      clearTimeout(this.acpBindTimer);
      this.acpBindTimer = null;
    }
    this.unsubscribeAcp = acp.onSessionEvent((sessionId, event, data) => {
      void this.handleAcpEvent(sessionId, String(event), data);
    });
    this.acpBindStatus = "bound";
    this.acpBindReason = null;
    logger.info(
      `[SwarmCoordinator] subscribed to ACP session-event stream${
        this.acpBindAttempts > 0
          ? ` (after ${this.acpBindAttempts} retr${
              this.acpBindAttempts === 1 ? "y" : "ies"
            })`
          : ""
      }`,
    );
  }

  /** Record a terminal bind failure and log at error level (LOUD). */
  private markUnbound(reason: string): void {
    if (this.acpBindTimer) {
      clearTimeout(this.acpBindTimer);
      this.acpBindTimer = null;
    }
    this.acpBindStatus = "unbound";
    this.acpBindReason = reason;
    logger.error(
      `[SwarmCoordinator] ACP bind failed — swarm event stream inactive, ` +
        `coding-agent supervision DEGRADED. Reason: ${reason}. ` +
        `Verify the AcpService started (check for its start log / ` +
        `ACP_SUBPROCESS_SERVICE errors above).`,
    );
  }

  /**
   * Polling fallback: re-check for the ACP service on a short interval. Unlike
   * the old bounded loop this never gives up, but it backs off and escalates
   * log severity so a stuck bind is impossible to miss. The event-driven
   * load-promise normally binds first (making this loop a no-op via the
   * `unsubscribeAcp` guard); the poll exists for runtimes that don't drive the
   * load-promise.
   */
  private scheduleAcpBindRetry(): void {
    if (this.stopped || this.unsubscribeAcp) return;
    // Attempt count at which the bind is "clearly wrong, not just slow". At
    // 500ms base this is ~60s — the old give-up point, now the START of loud
    // logging rather than the end of trying.
    const ESCALATE_AT = 120;
    const BASE_INTERVAL_MS = 500;
    const MAX_INTERVAL_MS = 5_000;
    this.acpBindAttempts += 1;

    // Backoff: hold the base cadence until the escalation point (so a normal
    // slow boot binds promptly), then grow to a coarse steady-state so an
    // indefinite wait doesn't burn a tight timer.
    const interval =
      this.acpBindAttempts < ESCALATE_AT
        ? BASE_INTERVAL_MS
        : Math.min(
            MAX_INTERVAL_MS,
            BASE_INTERVAL_MS * 2 ** (this.acpBindAttempts - ESCALATE_AT),
          );

    // Escalate severity once we cross the "this is taking too long" threshold.
    // First crossing is a warn; keep it grep-able but not spammy afterward.
    if (this.acpBindAttempts === ESCALATE_AT) {
      this.acpBindReason = `AcpService still unavailable after ${this.acpBindAttempts} attempts (~${Math.round(
        (BASE_INTERVAL_MS * this.acpBindAttempts) / 1000,
      )}s); still retrying`;
      logger.warn(
        `[SwarmCoordinator] ${this.acpBindReason}. If this persists, ` +
          `coding-agent supervision is degraded — check AcpService startup.`,
      );
    }

    this.acpBindTimer = setTimeout(() => {
      this.acpBindTimer = null;
      this.bindToAcp();
    }, interval);
  }

  /**
   * Re-shape one AcpService session event into a legacy {@link SwarmEvent} and
   * fan it out to subscribers + the ws-broadcast callback. Terminal events
   * additionally drive the swarm-complete synthesis callback.
   */
  private async handleAcpEvent(
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    // A non-terminal event means the session resumed: a follow-up prompt turn
    // reuses the same session (task_complete fires at the end of every turn, then
    // the session returns to a non-terminal status and accepts more input). Cancel
    // any pending post-terminal eviction so the still-live task state is not
    // deleted mid-turn. Also refresh cached enrichment metadata: session metadata
    // can be patched between turns, and a resumed turn must not reuse the prior
    // turn's stale snapshot — so this must run BEFORE enrichment below.
    if (!this.isTerminalEvent(event)) {
      this.cancelLegacyTaskEviction(sessionId);
    }

    const enrichedData = this.shouldEnrichEvent(event)
      ? await this.enrichEventData(sessionId, data)
      : data;

    // App/plugin creation flows carry a custom app-verification validator in
    // session metadata. The verification-room bridge intentionally ignores raw
    // ACP terminal events; it only accepts post-validator pass/fail payloads.
    // Run the real verifier first and emit the legacy custom-validator event
    // shape it expects, rather than announcing completion before validation.
    if (
      event === "task_complete" &&
      this.hasAppVerificationValidator(enrichedData)
    ) {
      await this.runCustomValidatorAndDispatch(sessionId, enrichedData);
      this.scheduleLegacyTaskEviction(sessionId);
      return;
    }

    const swarmEvent: SwarmEvent = {
      type: event,
      sessionId,
      timestamp: Date.now(),
      data: enrichedData,
    };
    this.updateLegacyTaskContext(sessionId, event, enrichedData);
    this.dispatchSwarmEvent(swarmEvent);
    await this.maybeFireSwarmComplete(sessionId, event, enrichedData);

    if (event === "blocked" || event === "login_required") {
      void this.maybeRouteAgentDecision(sessionId, event, enrichedData);
    }

    if (this.isTerminalEvent(event)) {
      this.scheduleLegacyTaskEviction(sessionId);
    }
  }

  private updateLegacyTaskContext(
    sessionId: string,
    event: string,
    data: unknown,
  ): void {
    if (!isRecord(data)) {
      this.tasks.set(sessionId, { sessionId, status: event });
      return;
    }
    const existing = this.tasks.get(sessionId);
    const status = this.legacyStatusForEvent(event);
    const label = readString(data, "label") ?? existing?.label;
    const threadId =
      readString(data, "threadId") ??
      readString(data, "taskId") ??
      existing?.threadId ??
      sessionId;
    const agentType = readString(data, "agentType") ?? existing?.agentType;
    const originalTask =
      readString(data, "initialTask") ??
      readString(data, "task") ??
      existing?.originalTask;
    const workdir = readString(data, "workdir") ?? existing?.workdir;
    const roomId =
      readString(data, "originRoomId") ??
      readString(data, "roomId") ??
      existing?.originMetadata?.roomId;
    const replyToExternalMessageId =
      readString(data, "replyToExternalMessageId") ??
      readString(data, "originConnectorMessageId") ??
      existing?.originMetadata?.replyToExternalMessageId;
    const originMessageId =
      readString(data, "originConnectorMessageId") ??
      readString(data, "messageId") ??
      existing?.originMetadata?.messageId;

    this.tasks.set(sessionId, {
      sessionId,
      ...(label ? { label } : {}),
      threadId,
      status,
      ...(agentType ? { agentType } : {}),
      ...(originalTask ? { originalTask } : {}),
      ...(workdir ? { workdir } : {}),
      originMetadata: {
        ...(originMessageId ? { messageId: originMessageId } : {}),
        ...(roomId ? { roomId } : {}),
        ...(replyToExternalMessageId ? { replyToExternalMessageId } : {}),
      },
    });
  }

  private legacyStatusForEvent(event: string): string {
    if (event === "task_complete") return "completed";
    if (event === "error") return "error";
    return event;
  }

  private async maybeFireSwarmComplete(
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const cb = this.swarmCompleteCallback;
    if (!cb) return;
    const terminalStatus = this.completionStatusForEvent(event);
    if (!terminalStatus) return;
    if (this.synthesizedCompletionSessions.has(sessionId)) return;
    this.synthesizedCompletionSessions.add(sessionId);

    const record = isRecord(data) ? data : {};
    let sessionMeta: EnrichmentMetadata = { metadata: {} };
    try {
      sessionMeta = await this.getEnrichmentMetadata(sessionId);
    } catch {
      sessionMeta = { metadata: {} };
    }
    const meta = sessionMeta.metadata;
    const label =
      readString(record, "label") ?? readString(meta, "label") ?? sessionId;
    const agentType =
      readString(record, "agentType") ??
      readString(meta, "agentType") ??
      sessionMeta.agentType ??
      "unknown";
    const originalTask =
      readString(record, "initialTask") ??
      readString(meta, "initialTask") ??
      readString(record, "task") ??
      readString(meta, "task") ??
      "";
    const workdir =
      readString(record, "workdir") ??
      readString(meta, "workdir") ??
      sessionMeta.workdir;
    const roomId =
      readString(record, "originRoomId") ??
      readString(meta, "originRoomId") ??
      readString(record, "roomId") ??
      readString(meta, "roomId") ??
      null;
    const replyToExternalMessageId =
      readString(record, "replyToExternalMessageId") ??
      readString(meta, "replyToExternalMessageId") ??
      readString(record, "originConnectorMessageId") ??
      readString(meta, "originConnectorMessageId") ??
      null;
    // The raw `response` here is the ACP turn's finalText, which CONTAINS the
    // orchestrator's own `[tool output: …]` envelope blocks appended by
    // captureTerminalToolOutput. This synthesis path posts completionSummary
    // VERBATIM to the connector (server-helpers-swarm.buildTaskResultLine →
    // routeSynthesisToConnector → Discord) with NO downstream stripping — the
    // round-3 raw-transcript leak in issue elizaOS/eliza#11578. Sanitize at the
    // SOURCE with the same shared stripper the sub-agent router uses, so the
    // envelopes never enter the callback payload. If nothing survives (the
    // deliverable WAS the tool output), fall back to the existing default.
    const rawSummary =
      readString(record, "response") ??
      readString(record, "summary") ??
      readString(record, "message") ??
      readString(record, "text");
    const sanitizedSummary = rawSummary
      ? sanitizeCompletionRelay(rawSummary)
      : "";
    const completionSummary =
      sanitizedSummary ||
      (terminalStatus === "completed"
        ? "Task completed."
        : `${label} ${terminalStatus}.`);

    try {
      await cb({
        tasks: [
          {
            sessionId,
            label,
            agentType,
            originalTask,
            status: terminalStatus,
            completionSummary,
            ...(workdir ? { workdir } : {}),
            roomId,
            replyToExternalMessageId,
          },
        ],
        total: 1,
        completed: terminalStatus === "completed" ? 1 : 0,
        stopped: terminalStatus === "stopped" ? 1 : 0,
        errored: terminalStatus === "errored" ? 1 : 0,
      });
    } catch (err) {
      logger.warn(
        `[SwarmCoordinator] swarm-complete callback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private completionStatusForEvent(
    event: string,
  ): "completed" | "stopped" | "errored" | null {
    if (event === "task_complete") return "completed";
    if (event === "stopped") return "stopped";
    if (event === "error") return "errored";
    return null;
  }

  private isTerminalEvent(event: string): boolean {
    return TERMINAL_SESSION_STATUSES.has(this.legacyStatusForEvent(event));
  }

  private scheduleLegacyTaskEviction(sessionId: string): void {
    const existing = this.legacyTaskEvictionTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    // Give same-turn consumers (swarm synthesis, verification routing, and
    // Discord timeout suppression) a short grace window to observe terminal
    // context, then evict legacy state so completed sessions do not accumulate
    // for the lifetime of the runtime.
    const timer = setTimeout(() => {
      this.legacyTaskEvictionTimers.delete(sessionId);
      this.tasks.delete(sessionId);
      this.synthesizedCompletionSessions.delete(sessionId);
      this.enrichmentMetadataCache.delete(sessionId);
    }, LEGACY_TASK_EVICTION_GRACE_MS);
    this.legacyTaskEvictionTimers.set(sessionId, timer);
  }

  private cancelLegacyTaskEviction(sessionId: string): void {
    const existing = this.legacyTaskEvictionTimers.get(sessionId);
    if (!existing) return;
    clearTimeout(existing);
    this.legacyTaskEvictionTimers.delete(sessionId);
    this.enrichmentMetadataCache.delete(sessionId);
  }

  private dispatchSwarmEvent(swarmEvent: SwarmEvent): void {
    // Fan out to in-process subscribers (verification-room-bridge et al).
    for (const listener of this.listeners) {
      try {
        listener(swarmEvent);
      } catch (err) {
        logger.warn(
          `[SwarmCoordinator] subscriber threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Relay to the WS broadcast bridge (frontend dashboard live status).
    if (this.wsBroadcast) {
      try {
        this.wsBroadcast(swarmEvent);
      } catch (err) {
        logger.warn(
          `[SwarmCoordinator] wsBroadcast threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private shouldEnrichEvent(event: string): boolean {
    return !STREAMING_SESSION_EVENTS.has(event);
  }

  private async getEnrichmentMetadata(
    sessionId: string,
  ): Promise<EnrichmentMetadata> {
    const cached = this.enrichmentMetadataCache.get(sessionId);
    if (cached) return cached;

    const session = await this.acp()?.getSession(sessionId);
    // Do NOT cache a miss: an event can race session-store persistence, and
    // pinning `{}` would strip routing metadata from every later event of the
    // session. A miss stays uncached so the next event retries the lookup.
    if (!session) return { metadata: {} };

    const cachedMetadata: EnrichmentMetadata = {
      metadata: isRecord(session.metadata) ? session.metadata : {},
      ...(session.workdir ? { workdir: session.workdir } : {}),
      ...(session.agentType ? { agentType: session.agentType } : {}),
    };
    this.enrichmentMetadataCache.set(sessionId, cachedMetadata);
    return cachedMetadata;
  }

  private async enrichEventData(
    sessionId: string,
    data: unknown,
  ): Promise<Record<string, unknown> | unknown> {
    const record: Record<string, unknown> = isRecord(data)
      ? { ...data }
      : { value: data };
    try {
      const sessionMeta = await this.getEnrichmentMetadata(sessionId);
      const meta = sessionMeta.metadata;
      for (const key of [
        "originRoomId",
        "originConnectorMessageId",
        "replyToExternalMessageId",
        "messageId",
        "roomId",
        "taskRoomId",
        "workdir",
        "label",
        "agentType",
        "initialTask",
        "task",
        "threadId",
        "validator",
        "onVerificationFail",
        "maxRetries",
        "retryCount",
      ]) {
        if (record[key] === undefined && meta[key] !== undefined) {
          record[key] = meta[key];
        }
      }
      if (record.workdir === undefined && sessionMeta.workdir) {
        record.workdir = sessionMeta.workdir;
      }
      if (record.agentType === undefined && sessionMeta.agentType) {
        record.agentType = sessionMeta.agentType;
      }
    } catch {
      // Best-effort enrichment only; raw data is still useful to consumers.
    }
    return record;
  }

  private hasAppVerificationValidator(data: unknown): boolean {
    if (!isRecord(data)) return false;
    const validator = isRecord(data.validator) ? data.validator : null;
    return validator?.service === "app-verification";
  }

  private async runCustomValidatorAndDispatch(
    sessionId: string,
    enrichedData: unknown,
  ): Promise<void> {
    if (!isRecord(enrichedData)) return;
    const validator = isRecord(enrichedData.validator)
      ? enrichedData.validator
      : null;
    if (validator?.service !== "app-verification") return;
    const method =
      validator.method === "verifyApp" || validator.method === "verifyPlugin"
        ? validator.method
        : null;
    if (!method) return;
    const verificationService = this.runtime.getService?.("app-verification") as
      | {
          verifyApp?: (
            opts: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
          verifyPlugin?: (
            opts: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        }
      | null
      | undefined;
    const verify = verificationService?.[method];
    if (typeof verify !== "function") {
      logger.warn("[SwarmCoordinator] app-verification service unavailable");
      await this.dispatchCustomValidatorResult(sessionId, "escalation", {
        ...enrichedData,
        summary: "App verification service unavailable.",
        verification: {
          source: "custom-validator",
          validator: { service: "app-verification", method },
          params: isRecord(validator.params) ? validator.params : {},
          verdict: "fail",
        },
      });
      return;
    }
    const params = {
      ...(isRecord(validator.params) ? validator.params : {}),
      ...(typeof enrichedData.workdir === "string"
        ? { workdir: enrichedData.workdir }
        : {}),
    };
    try {
      const result = await verify.call(verificationService, params);
      const verdict = result.verdict === "pass" ? "pass" : "fail";
      const checks = Array.isArray(result.checks) ? result.checks : [];
      const failed = checks
        .filter(
          (check): check is Record<string, unknown> =>
            isRecord(check) && check.ok === false,
        )
        .map((check) => readString(check, "label") ?? readString(check, "name"))
        .filter((value): value is string => Boolean(value));
      const summary =
        verdict === "pass"
          ? "App verification passed."
          : failed.length > 0
            ? `App verification failed: ${failed.join(", ")}`
            : "App verification failed.";
      await this.dispatchCustomValidatorResult(
        sessionId,
        verdict === "pass" ? "task_complete" : "escalation",
        {
          ...enrichedData,
          summary,
          verification: {
            source: "custom-validator",
            validator: { service: "app-verification", method },
            params,
            verdict,
            result,
          },
        },
      );
    } catch (err) {
      logger.warn(
        `[SwarmCoordinator] custom validator failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.dispatchCustomValidatorResult(sessionId, "escalation", {
        ...enrichedData,
        summary: err instanceof Error ? err.message : String(err),
        verification: {
          source: "custom-validator",
          validator: { service: "app-verification", method },
          params,
          verdict: "fail",
        },
      });
    }
  }

  private async dispatchCustomValidatorResult(
    sessionId: string,
    event: "task_complete" | "escalation",
    data: Record<string, unknown>,
  ): Promise<void> {
    this.updateLegacyTaskContext(sessionId, event, data);
    this.dispatchSwarmEvent({
      type: event,
      sessionId,
      timestamp: Date.now(),
      data,
    });
    await this.maybeFireSwarmComplete(sessionId, event, data);
  }

  /**
   * Route user-action events through the server-provided Eliza pipeline. This
   * is the post-consolidation equivalent of the deleted coordinator's
   * decision-loop callback path: the server wires `setAgentDecisionCallback`,
   * we invoke it for blocking/auth events, and a simple `respond` decision is
   * sent back into the live ACP session.
   */
  private async maybeRouteAgentDecision(
    sessionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const cb = this.agentDecisionCallback;
    if (!cb || this.inFlightDecisionSessions.has(sessionId)) return;
    this.inFlightDecisionSessions.add(sessionId);
    try {
      const acp = this.acp();
      const session = acp ? await acp.getSession(sessionId) : undefined;
      const meta = isRecord(session?.metadata) ? session.metadata : {};
      const record = isRecord(data) ? data : {};
      const label =
        readString(meta, "label") ?? readString(record, "label") ?? sessionId;
      const message =
        readString(record, "message") ??
        readString(record, "prompt") ??
        readString(record, "text") ??
        event;
      const taskContext: TaskContextLike = {
        threadId:
          readString(meta, "threadId") ??
          readString(meta, "taskId") ??
          sessionId,
        sessionId,
        agentType:
          readString(meta, "agentType") ?? session?.agentType ?? "unknown",
        label,
        originalTask:
          readString(meta, "initialTask") ?? readString(meta, "task") ?? "",
        workdir: session?.workdir ?? readString(meta, "workdir") ?? "",
        status: event,
      };
      const eventDescription = `[${label}] ${event}: ${message}`;
      const decision = await cb(eventDescription, sessionId, taskContext);
      if (!isRecord(decision)) return;
      if (
        decision.action === "respond" &&
        typeof decision.response === "string" &&
        decision.response.trim().length > 0 &&
        typeof acp?.sendPrompt === "function"
      ) {
        await acp
          .sendPrompt(sessionId, decision.response.trim())
          .catch((err: unknown) => {
            logger.warn(
              `[SwarmCoordinator] failed to send decision response: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch (err) {
      logger.warn(
        `[SwarmCoordinator] agent decision callback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.inFlightDecisionSessions.delete(sessionId);
    }
  }

  /**
   * Whether a session status string is terminal. Exposed for parity with the
   * shared TERMINAL_SESSION_STATUSES set the providers + progress hook use.
   */
  static isTerminalStatus(status: string): boolean {
    return TERMINAL_SESSION_STATUSES.has(status);
  }
}

export default SwarmCoordinatorService;
