/**
 * Per-session async serialization queue.
 * Ensures only one event is processed at a time per session.
 */

export interface QueuedEvent {
  sessionId: string;
  type: "blocked" | "turn_complete";
  data: unknown;
  enqueuedAt: number;
}

export class SessionEventQueue {
  private queues: Map<string, QueuedEvent[]> = new Map();
  private processing: Set<string> = new Set();
  private handler: (event: QueuedEvent) => Promise<void>;
  private logger: { warn: (msg: string) => void };

  constructor(
    handler: (event: QueuedEvent) => Promise<void>,
    logger?: { warn: (msg: string) => void },
  ) {
    this.handler = handler;
    this.logger = logger ?? { warn: (msg: string) => console.warn(msg) };
  }

  enqueue(event: QueuedEvent): void {
    const { sessionId } = event;

    if (!this.queues.has(sessionId)) {
      this.queues.set(sessionId, []);
    }
    this.queues.get(sessionId)?.push(event);

    if (!this.processing.has(sessionId)) {
      this.processLoop(sessionId);
    }
  }

  isProcessing(sessionId: string): boolean {
    return this.processing.has(sessionId);
  }

  clear(sessionId?: string): void {
    if (sessionId !== undefined) {
      this.queues.delete(sessionId);
    } else {
      this.queues.clear();
    }
  }

  pendingCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  private async processLoop(sessionId: string): Promise<void> {
    this.processing.add(sessionId);

    try {
      while (true) {
        const queue = this.queues.get(sessionId);
        if (!queue || queue.length === 0) {
          break;
        }

        const event = queue.shift()!;

        try {
          await this.handler(event);
        } catch (err) {
          this.logger.warn(
            `SessionEventQueue: handler error for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.processing.delete(sessionId);
      // Clean up empty queues
      const queue = this.queues.get(sessionId);
      if (queue && queue.length === 0) {
        this.queues.delete(sessionId);
      }
    }
  }
}
