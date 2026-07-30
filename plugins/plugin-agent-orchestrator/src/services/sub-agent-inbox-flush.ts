/**
 * Delivers queued user input when an ACP session publishes an authoritative
 * ready transition. The flush owns its listener and async work so plugin
 * teardown can detach first, stop ACP, and then drain without polling.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { AcpService } from "./acp-service.js";
import { isSessionBusy } from "./active-session-forward.js";
import type { SubAgentInbox } from "./sub-agent-inbox.js";
import { type SessionInfo, TERMINAL_SESSION_STATUSES } from "./types.js";

type FlushAcp = Pick<
  AcpService,
  "getSession" | "onSessionEvent" | "sendPrompt"
>;

export class SubAgentInboxFlush {
  private readonly active = new Set<Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly requested = new Set<string>();
  private disposeListener: (() => void) | undefined;
  private stopped = false;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly acp: FlushAcp,
    private readonly inbox: SubAgentInbox,
  ) {}

  start(): void {
    if (this.disposeListener) return;
    this.stopped = false;
    this.disposeListener = this.acp.onSessionEvent((sessionId, event) => {
      if (event === "ready" || event === "reconnected") {
        this.request(sessionId);
      } else if (TERMINAL_SESSION_STATUSES.has(event)) {
        this.requested.delete(sessionId);
        this.inbox.clear(sessionId);
      }
    });
  }

  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.disposeListener?.();
    } catch (err) {
      // error-policy:J6 listener teardown is best-effort; stopped state and
      // inbox cleanup still prevent any new delivery work.
      this.runtime.logger?.warn?.(
        {
          src: "@elizaos/plugin-agent-orchestrator",
          err: err instanceof Error ? err.message : String(err),
        },
        "inbox flush listener teardown failed",
      );
    }
    this.disposeListener = undefined;
    this.requested.clear();
    this.inbox.clearAll();
  }

  async drain(): Promise<void> {
    await Promise.all(this.active);
  }

  private request(sessionId: string): void {
    if (this.stopped || this.inbox.size(sessionId) === 0) return;
    this.requested.add(sessionId);
    if (this.pending.has(sessionId)) return;

    this.pending.add(sessionId);
    const promise = this.flush(sessionId).finally(() => {
      this.active.delete(promise);
      this.pending.delete(sessionId);
      if (!this.stopped && this.requested.has(sessionId)) {
        this.request(sessionId);
      }
    });
    this.active.add(promise);
  }

  private async flush(sessionId: string): Promise<void> {
    while (!this.stopped && this.requested.delete(sessionId)) {
      if (this.inbox.size(sessionId) === 0) continue;

      let session: SessionInfo | undefined;
      try {
        session = await this.acp.getSession(sessionId);
      } catch (err) {
        // error-policy:J7 a store read must not discard queued user input;
        // surface it and leave the inbox intact for the next ready event.
        this.runtime.reportError?.("SubAgentInbox.flush", err, {
          sessionId,
          phase: "getSession",
        });
        this.runtime.logger?.warn?.(
          {
            src: "@elizaos/plugin-agent-orchestrator",
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "inbox flush session lookup failed",
        );
        return;
      }

      if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) {
        this.inbox.clear(sessionId);
        return;
      }
      if (isSessionBusy(session.status)) return;

      const queued = this.inbox.drain(sessionId);
      if (!queued) return;
      try {
        await this.acp.sendPrompt(sessionId, queued);
      } catch (err) {
        if (this.stopped) return;
        // error-policy:J7 a failed prompt is requeued and surfaced; its next
        // ready/reconnected event is the retry signal.
        this.inbox.enqueue(sessionId, queued);
        this.runtime.reportError?.("SubAgentInbox.flush", err, {
          sessionId,
          phase: "sendPrompt",
        });
        this.runtime.logger?.warn?.(
          {
            src: "@elizaos/plugin-agent-orchestrator",
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "inbox flush failed; requeued",
        );
        return;
      }
    }
  }
}
