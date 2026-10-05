export type ConversationRoom = Readonly<{ id: string; roomId: string }>;
export type ConversationStopResult =
  | { status: "idle" | "stopped" }
  | { status: "failed"; error: unknown };
export type ConversationTurnObserver<Reply> = {
  reply: (reply: Reply) => void;
  error: (error: unknown) => void;
  settled: () => void;
};
export type ConversationTurnTransport<Input, Reply> = {
  create: () => Promise<ConversationRoom>;
  send: (conversation: ConversationRoom, input: Input) => Promise<Reply>;
  stop: (conversation: ConversationRoom) => Promise<unknown>;
  ownershipLost: (error: unknown) => boolean;
};
type Turn = { room: ConversationRoom | null; dispatched: boolean };

/** Browser-safe explicit-send lifecycle. No drafts, UI, auto-send or effect replay. */
export class ConversationTurnController<Input, Reply> {
  private room: ConversationRoom | null = null;
  private turn: Turn | null = null;
  private stopping: Promise<ConversationStopResult> | null = null;

  private readonly transport: ConversationTurnTransport<Input, Reply>;
  constructor(transport: ConversationTurnTransport<Input, Reply>) {
    this.transport = transport;
  }

  get pending(): boolean {
    return this.turn !== null;
  }

  async send(
    input: Input,
    observer: ConversationTurnObserver<Reply>,
  ): Promise<boolean> {
    if (this.turn) return false;
    const turn: Turn = { room: null, dispatched: false };
    this.turn = turn;
    try {
      const stopping = this.stopping;
      if (stopping) {
        const result = await stopping;
        if (this.turn !== turn) return false;
        if (this.stopping === stopping) this.stopping = null;
        if (result.status === "failed") throw result.error;
      }
      const room = this.room ?? (await this.transport.create());
      if (this.turn !== turn) return false;
      if (
        !room ||
        typeof room.id !== "string" ||
        !room.id.trim() ||
        typeof room.roomId !== "string" ||
        !room.roomId.trim()
      )
        throw new TypeError("Invalid conversation identity");
      // Copy server identity so a transport cannot mutate an active abort target.
      this.room = Object.freeze({ id: room.id, roomId: room.roomId });
      turn.room = this.room;
      turn.dispatched = true;
      const reply = await this.transport.send(turn.room, input);
      if (this.turn !== turn) return false;
      observer.reply(reply);
      return true;
    } catch (error) {
      // error-policy:J1 Only the current operation reports failure; no automatic replay.
      if (this.turn !== turn) return false;
      if (this.transport.ownershipLost(error)) this.room = null;
      observer.error(error);
      return false;
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        observer.settled();
      }
    }
  }

  /** Cancels local publication immediately. A later explicit send waits for remote stop. */
  interrupt(): Promise<ConversationStopResult> {
    const turn = this.turn;
    this.turn = null;
    if (!turn?.dispatched || !turn.room)
      return this.stopping ?? Promise.resolve({ status: "idle" });
    const room = turn.room;
    const failed = (error: unknown): ConversationStopResult => {
      // An uncertain old-room abort must never target the next conversation.
      if (this.room === room) this.room = null;
      return { status: "failed", error };
    };
    try {
      this.stopping = Promise.resolve(this.transport.stop(room)).then(
        (): ConversationStopResult => ({ status: "stopped" }),
        failed,
      );
    } catch (error) {
      // error-policy:J1 A synchronous transport failure has the same explicit receipt.
      this.stopping = Promise.resolve(failed(error));
    }
    return this.stopping;
  }

  /** Ownership changes and teardown invalidate all callbacks and cached identities. */
  reset(): Promise<ConversationStopResult> {
    const stopped = this.interrupt();
    this.room = null;
    this.stopping = null;
    return stopped;
  }
}
