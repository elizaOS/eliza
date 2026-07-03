/**
 * Live meeting WebSocket fan-out.
 *
 * Seam: the agent API server already injects its `broadcastWs` into the
 * always-registered `connector-setup` service at startup
 * (`packages/agent/src/api/server.ts` → `setupSvc.setBroadcastWs(state.broadcastWs)`;
 * `ConnectorSetupService.broadcastWs` relays to every connected dashboard WS
 * client). Publishing `MeetingWsEvent` envelopes through that service needs
 * ZERO changes in packages/agent — it is the same path Signal/WhatsApp pairing
 * events already ride.
 *
 * Policy: `meeting-status` is emitted on every session transition (rare);
 * `meeting-transcript` is throttled to at most 2 events/second per session
 * with a trailing flush so the last update always lands.
 */

import { logger } from "@elizaos/core";
import type {
  MeetingSession,
  MeetingTranscriptEvent,
  MeetingWsEvent,
} from "@elizaos/shared";

/** Minimum ms between meeting-transcript events per session (≤2/s). */
export const TRANSCRIPT_EVENT_MIN_INTERVAL_MS = 500;

/** The broadcast surface of the connector-setup service (structural). */
interface BroadcastLike {
  broadcastWs(data: object): void;
}

/** The runtime surface the emitter needs (IAgentRuntime satisfies it). */
export interface MeetingEventRuntime {
  getService(name: string): unknown;
}

export class MeetingEventEmitter {
  private lastTranscriptEmitAt = new Map<string, number>();
  private pendingTranscript = new Map<
    string,
    { event: MeetingTranscriptEvent; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly runtime: MeetingEventRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  /** Push one session lifecycle transition to every connected client. */
  emitStatus(session: MeetingSession): void {
    this.broadcast({ type: "meeting-status", session });
  }

  /**
   * Push a live transcript delta, coalesced to ≤2 events/second per session.
   * A burst inside the window replaces the queued event (each update carries
   * the full confirmed delta + current pending tail from the pipeline).
   */
  emitTranscript(event: MeetingTranscriptEvent): void {
    const key = event.sessionId;
    const last = this.lastTranscriptEmitAt.get(key) ?? 0;
    const elapsed = this.now() - last;
    const queued = this.pendingTranscript.get(key);
    if (elapsed >= TRANSCRIPT_EVENT_MIN_INTERVAL_MS && !queued) {
      this.lastTranscriptEmitAt.set(key, this.now());
      this.broadcast(event);
      return;
    }
    if (queued) {
      // Merge: keep all not-yet-sent confirmed segments, replace pending tail.
      const merged: MeetingTranscriptEvent = {
        ...event,
        confirmed: [...queued.event.confirmed, ...event.confirmed],
      };
      queued.event = merged;
      return;
    }
    const delay = Math.max(TRANSCRIPT_EVENT_MIN_INTERVAL_MS - elapsed, 0);
    const timer = setTimeout(() => {
      const entry = this.pendingTranscript.get(key);
      this.pendingTranscript.delete(key);
      if (!entry) return;
      this.lastTranscriptEmitAt.set(key, this.now());
      this.broadcast(entry.event);
    }, delay);
    timer.unref?.();
    this.pendingTranscript.set(key, { event, timer });
  }

  /** Flush + drop any queued transcript event for an ending session. */
  dispose(sessionId: string): void {
    const queued = this.pendingTranscript.get(sessionId);
    if (queued) {
      clearTimeout(queued.timer);
      this.pendingTranscript.delete(sessionId);
      this.broadcast(queued.event);
    }
    this.lastTranscriptEmitAt.delete(sessionId);
  }

  private broadcast(event: MeetingWsEvent): void {
    const setup = this.runtime.getService(
      "connector-setup",
    ) as BroadcastLike | null;
    if (!setup) {
      logger.debug(
        { type: event.type },
        "[MeetingService] connector-setup service unavailable — WS event dropped",
      );
      return;
    }
    setup.broadcastWs(event);
  }
}
