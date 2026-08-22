/**
 * Per-session message inbox for the interruption decider.
 *
 * When a room message is QUEUEd (relevant but the sub-agent is mid-turn) or an
 * INTERRUPT cancels the current turn, the text lands here and is flushed to the
 * sub-agent the moment it returns to an idle state. This keeps a working
 * sub-agent from being derailed mid-turn while guaranteeing the human's message
 * is still delivered — the "continue without interruption unless required"
 * contract. The queue is lossless: a delayed message may wait, but is never
 * evicted before delivery.
 */

const DEFAULT_CAP = 16;

/**
 * Called when enqueue drops entries past the cap. `droppedNow` is the count
 * dropped by this enqueue; `droppedTotal` the session's cumulative drops.
 */
export type InboxOverflowObserver = (
  sessionId: string,
  droppedNow: number,
  droppedTotal: number,
) => void;

export class SubAgentInbox {
  private readonly pending = new Map<string, string[]>();
  private readonly droppedTotals = new Map<string, number>();
  private onOverflow: InboxOverflowObserver | undefined;

  constructor(cap: number = DEFAULT_CAP) {
    void cap;
  }

  /**
   * Register the overflow observer. The inbox is constructed at plugin-factory
   * scope before any runtime exists, so the runtime-bound warn/reportError
   * hookup happens later, in plugin init.
   */
  setOverflowObserver(observer: InboxOverflowObserver | undefined): void {
    this.onOverflow = observer;
  }

  /** Queue a message for a session without evicting earlier input. */
  enqueue(sessionId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const queue = this.pending.get(sessionId) ?? [];
    queue.push(trimmed);
    this.pending.set(sessionId, queue);
  }

  size(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  /** Cumulative count of messages dropped past the cap for a session. */
  droppedCount(sessionId: string): number {
    return this.droppedTotals.get(sessionId) ?? 0;
  }

  /**
   * Remove and return the queued messages for a session as one combined
   * string (newline-joined), or null when nothing is queued.
   */
  drain(sessionId: string): string | null {
    const queue = this.pending.get(sessionId);
    if (!queue || queue.length === 0) return null;
    this.pending.delete(sessionId);
    return queue.join("\n");
  }

  clear(sessionId: string): void {
    this.pending.delete(sessionId);
    this.droppedTotals.delete(sessionId);
  }

  clearAll(): void {
    this.pending.clear();
    this.droppedTotals.clear();
  }
}
