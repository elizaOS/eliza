/**
 * Per-session message inbox for the interruption decider.
 *
 * When a room message is QUEUEd (relevant but the sub-agent is mid-turn) or an
 * INTERRUPT cancels the current turn, the text lands here and is flushed to the
 * sub-agent the moment it returns to an idle state. This keeps a working
 * sub-agent from being derailed mid-turn while guaranteeing the human's message
 * is still delivered — the "continue without interruption unless required"
 * contract.
 */

const DEFAULT_CAP = 16;

export class SubAgentInbox {
  private readonly pending = new Map<string, string[]>();
  private readonly cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = Math.max(1, cap);
  }

  /** Queue a message for a session. Oldest entries drop past the cap. */
  enqueue(sessionId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const queue = this.pending.get(sessionId) ?? [];
    queue.push(trimmed);
    while (queue.length > this.cap) queue.shift();
    this.pending.set(sessionId, queue);
  }

  size(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
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
  }

  clearAll(): void {
    this.pending.clear();
  }
}
