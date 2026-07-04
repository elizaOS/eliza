// Supports InterruptBench turn-interruption scoring and scripted scenario execution.
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  [key: string]: unknown;
}

export interface ResponseHandlerResult {
  shouldRespond: "RESPOND" | "IGNORE" | "STOP";
  contexts: string[];
  intents: string[];
  candidateActionNames: string[];
  replyText: string;
  facts: string[];
  relationships: Array<{
    subject: string;
    predicate: string;
    object: string;
  }>;
  addressedTo: string[];
  [extra: string]: unknown;
}

export interface ResponseHandlerFieldEvaluator<TValue = unknown> {
  name: string;
  description: string;
  priority?: number;
  schema: JSONSchema;
}

export class ResponseHandlerFieldRegistry {
  private evaluators = new Map<string, ResponseHandlerFieldEvaluator>();

  register(evaluator: ResponseHandlerFieldEvaluator): void {
    if (this.evaluators.has(evaluator.name)) return;
    this.evaluators.set(evaluator.name, evaluator);
  }

  list(): ReadonlyArray<ResponseHandlerFieldEvaluator> {
    return this.sortedEvaluators();
  }

  composeSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const evaluator of this.sortedEvaluators()) {
      properties[evaluator.name] = evaluator.schema;
      required.push(evaluator.name);
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    };
  }

  private sortedEvaluators(): ResponseHandlerFieldEvaluator[] {
    return [...this.evaluators.values()].sort((a, b) => {
      const pa = a.priority ?? 100;
      const pb = b.priority ?? 100;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    });
  }
}

interface QueuedItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

class RoomQueue {
  private queue: QueuedItem<unknown>[] = [];
  private active: QueuedItem<unknown> | null = null;

  get pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  async quiesce(): Promise<void> {
    while (this.queue.length > 0 || this.active) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }

  private drain(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    Promise.resolve()
      .then(() => next.fn())
      .then(
        (value) => {
          next.resolve(value);
          this.active = null;
          this.drain();
        },
        (error) => {
          next.reject(error);
          this.active = null;
          this.drain();
        },
      );
  }
}

export class RoomHandlerQueue {
  private rooms = new Map<string, RoomQueue>();

  async runWith<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    return this.getQueue(roomId).enqueue(fn);
  }

  async quiesceAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((queue) => queue.quiesce()));
  }

  private getQueue(roomId: string): RoomQueue {
    let queue = this.rooms.get(roomId);
    if (!queue) {
      queue = new RoomQueue();
      this.rooms.set(roomId, queue);
    }
    return queue;
  }
}

interface ActiveTurn {
  controller: AbortController;
  reason?: string;
}

export class TurnAbortedError extends Error {
  readonly code = "TURN_ABORTED";

  constructor(readonly reason: string) {
    super(`Turn aborted: ${reason}`);
  }
}

export class TurnControllerRegistry {
  private active = new Map<string, ActiveTurn>();

  async runWith<T>(
    roomId: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const turn = { controller: new AbortController() };
    this.active.set(roomId, turn);
    try {
      return await fn(turn.controller.signal);
    } finally {
      if (this.active.get(roomId) === turn) {
        this.active.delete(roomId);
      }
    }
  }

  abortTurn(roomId: string, reason: string): boolean {
    const turn = this.active.get(roomId);
    if (!turn || turn.controller.signal.aborted) return false;
    turn.reason = reason;
    turn.controller.abort(new TurnAbortedError(reason));
    return true;
  }
}
