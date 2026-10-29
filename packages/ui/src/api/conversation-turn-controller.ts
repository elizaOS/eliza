/**
 * Browser-safe explicit-send lifecycle shared by every chat surface.
 *
 * One controller owns one conversation binding and at most one turn. It never
 * stores drafts, never sends automatically and never replays a write: a turn
 * that reached the transport and then failed is reported with
 * `dispatched: true`, and only a new explicit send (with a new
 * `clientMessageId`) may follow.
 *
 * - Generation fence: `reset()` and `bind()` advance the generation. Every
 *   callback, streaming update and host-side fence from an older generation
 *   is dropped.
 * - Stop before replacement: an explicit stop is awaited before the next send
 *   or before another conversation is bound. An unconfirmed stop clears the
 *   binding so an uncertain abort never targets the next conversation.
 * - Typed refusal: every send the controller declines is reported as a
 *   `ConversationTurnRefusal` with a stable code.
 * - Stopped-reply matching: each turn carries a `clientMessageId`; a stopped
 *   dispatched turn is retained so hosts can find its user row later
 *   (see `findStoppedUserTurn`).
 */
export type ConversationRoom = Readonly<{ id: string; roomId: string }>;
export type ConversationStopResult =
  | { status: "idle" | "stopped" }
  | { status: "failed"; error: unknown };

export type ConversationTurnRefusalCode =
  /** Another turn is in flight on this controller. */
  | "busy"
  /** The previous explicit stop was not confirmed; the binding was cleared. */
  | "stop-unconfirmed"
  /** The transport returned an unusable conversation identity. */
  | "invalid-identity";
export class ConversationTurnRefusal extends Error {
  override readonly name = "ConversationTurnRefusal";
  readonly code: ConversationTurnRefusalCode;
  override readonly cause?: unknown;
  constructor(
    code: ConversationTurnRefusalCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
export function isConversationTurnRefusal(
  value: unknown,
): value is ConversationTurnRefusal {
  return value instanceof ConversationTurnRefusal;
}

/** Per-turn identity and liveness handed to the transport. */
export type ConversationTurnContext = Readonly<{
  clientMessageId: string;
  generation: number;
  /** Aborted by `interrupt()`/`reset()`/`bind()`; streaming reads must stop. */
  signal: AbortSignal;
  /** False once this turn no longer owns publication (stream updates must be dropped). */
  current: () => boolean;
}>;
export type ConversationTurnFailure = Readonly<{
  /** The request may have reached the agent. Never repeat it automatically. */
  dispatched: boolean;
  clientMessageId: string;
}>;
export type ConversationTurnObserver<Reply> = {
  reply: (reply: Reply) => void;
  error: (error: unknown, failure?: ConversationTurnFailure) => void;
  settled: () => void;
  /** A send the controller declined before dispatch. Defaults to `error`. */
  refused?: (refusal: ConversationTurnRefusal) => void;
};
export type ConversationTurnTransport<Input, Reply> = {
  create: () => Promise<ConversationRoom>;
  send: (
    conversation: ConversationRoom,
    input: Input,
    turn: ConversationTurnContext,
  ) => Promise<Reply>;
  stop: (conversation: ConversationRoom) => Promise<unknown>;
  ownershipLost: (error: unknown) => boolean;
  /** Override for deterministic tests; defaults to `crypto.randomUUID()`. */
  clientMessageId?: () => string;
};
/** A dispatched turn the owner stopped, retained for later reply matching. */
export type StoppedConversationTurn<Input> = Readonly<{
  conversation: ConversationRoom;
  clientMessageId: string;
  input: Input;
  sentAt: number;
}>;
type Turn<Input> = {
  room: ConversationRoom | null;
  dispatched: boolean;
  generation: number;
  clientMessageId: string;
  input: Input;
  sentAt: number;
  abort: AbortController;
};

function validRoom(room: ConversationRoom | null | undefined): boolean {
  return (
    !!room &&
    typeof room.id === "string" &&
    !!room.id.trim() &&
    typeof room.roomId === "string" &&
    !!room.roomId.trim()
  );
}
function freeze(room: ConversationRoom): ConversationRoom {
  // Copy server identity so a transport cannot mutate an active abort target.
  return Object.freeze({ id: room.id, roomId: room.roomId });
}

export class ConversationTurnController<Input, Reply> {
  private room: ConversationRoom | null = null;
  private turn: Turn<Input> | null = null;
  private stopping: Promise<ConversationStopResult> | null = null;
  private stoppedTurn: StoppedConversationTurn<Input> | null = null;
  private generationValue = 0;

  private readonly transport: ConversationTurnTransport<Input, Reply>;
  constructor(transport: ConversationTurnTransport<Input, Reply>) {
    this.transport = transport;
  }

  get pending(): boolean {
    return this.turn !== null;
  }
  /** Advances on every ownership change (`reset`, `bind` to another conversation). */
  get generation(): number {
    return this.generationValue;
  }
  /** The bound server conversation, if any. */
  get conversation(): ConversationRoom | null {
    return this.room;
  }
  /** The last dispatched turn the owner stopped in this generation. */
  get stopped(): StoppedConversationTurn<Input> | null {
    return this.stoppedTurn;
  }
  /** A host-side fence: true while no ownership change happened since it was taken. */
  fence(): () => boolean {
    const generation = this.generationValue;
    return () => generation === this.generationValue;
  }

  /**
   * Narrow resident-client entry: adopt a server-bound conversation the host
   * already owns (for example from its conversation list) instead of creating
   * one. Binding another conversation stops a dispatched turn first and
   * advances the generation. Rebinding the same identity is a no-op.
   */
  bind(conversation: ConversationRoom): Promise<ConversationStopResult> {
    if (!validRoom(conversation))
      throw new ConversationTurnRefusal(
        "invalid-identity",
        "Invalid conversation identity",
      );
    if (
      this.room &&
      this.room.id === conversation.id &&
      this.room.roomId === conversation.roomId
    )
      return this.stopping ?? Promise.resolve({ status: "idle" });
    const stopped = this.interrupt();
    this.generationValue++;
    this.stoppedTurn = null;
    this.room = freeze(conversation);
    return stopped;
  }

  /** Clears a dispatched-turn record once the host matched or abandoned it. */
  clearStopped(clientMessageId?: string): void {
    if (
      clientMessageId === undefined ||
      this.stoppedTurn?.clientMessageId === clientMessageId
    )
      this.stoppedTurn = null;
  }

  async send(
    input: Input,
    observer: ConversationTurnObserver<Reply>,
  ): Promise<boolean> {
    const refuse = (refusal: ConversationTurnRefusal) =>
      observer.refused ? observer.refused(refusal) : observer.error(refusal);
    if (this.turn) {
      refuse(
        new ConversationTurnRefusal(
          "busy",
          "Wait for the current reply or stop it.",
        ),
      );
      return false;
    }
    const turn: Turn<Input> = {
      room: null,
      dispatched: false,
      generation: this.generationValue,
      clientMessageId: (
        this.transport.clientMessageId ?? (() => crypto.randomUUID())
      )(),
      input,
      sentAt: Date.now(),
      abort: new AbortController(),
    };
    const owned = () =>
      this.turn === turn && turn.generation === this.generationValue;
    this.turn = turn;
    try {
      const stopping = this.stopping;
      if (stopping) {
        const result = await stopping;
        if (!owned()) return false;
        if (this.stopping === stopping) this.stopping = null;
        if (result.status === "failed") {
          refuse(
            new ConversationTurnRefusal(
              "stop-unconfirmed",
              "The previous reply could not be confirmed stopped. Check the conversation before sending again.",
              result.error,
            ),
          );
          return false;
        }
      }
      const room = this.room ?? (await this.transport.create());
      if (!owned()) return false;
      if (!validRoom(room)) {
        refuse(
          new ConversationTurnRefusal(
            "invalid-identity",
            "Invalid conversation identity",
          ),
        );
        return false;
      }
      this.room = room === this.room ? room : freeze(room);
      turn.room = this.room;
      turn.dispatched = true;
      const reply = await this.transport.send(turn.room, input, {
        clientMessageId: turn.clientMessageId,
        generation: turn.generation,
        signal: turn.abort.signal,
        current: owned,
      });
      if (!owned()) return false;
      observer.reply(reply);
      return true;
    } catch (error) {
      // error-policy:J1 Only the current operation reports failure; no automatic replay.
      if (!owned()) return false;
      if (this.transport.ownershipLost(error)) this.room = null;
      observer.error(error, {
        dispatched: turn.dispatched,
        clientMessageId: turn.clientMessageId,
      });
      return false;
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        if (turn.generation === this.generationValue) observer.settled();
      }
    }
  }

  /** Cancels local publication immediately. A later explicit send waits for remote stop. */
  interrupt(): Promise<ConversationStopResult> {
    const turn = this.turn;
    this.turn = null;
    turn?.abort.abort();
    if (!turn?.dispatched || !turn.room)
      return this.stopping ?? Promise.resolve({ status: "idle" });
    const room = turn.room;
    this.stoppedTurn = Object.freeze({
      conversation: room,
      clientMessageId: turn.clientMessageId,
      input: turn.input,
      sentAt: turn.sentAt,
    });
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
    this.generationValue++;
    this.room = null;
    this.stopping = null;
    this.stoppedTurn = null;
    return stopped;
  }
}

/** A stopped send as a host recorded it: its clientMessageId, restored text and local time. */
export type StoppedUserTurn = {
  clientMessageId?: string;
  text: string;
  sentAt: number;
};
/** How far before the local send time an agent clock may stamp the same user row. */
export const STOPPED_TURN_CLOCK_SKEW_MS = 120_000;

/**
 * Finds the user row of a stopped turn in a conversation read (oldest first).
 *
 * Agents return `clientMessageId` on user rows sent with one. When the read
 * carries any such id, the row is matched by id only, so an earlier turn with
 * identical text is never taken for the stopped one, and an unrecorded send
 * matches nothing. Older agents and shared-tier Cloud agents return no ids;
 * for them the last user row with the same restored text sent no earlier than
 * two minutes before the local send time is used.
 */
export function findStoppedUserTurn<T extends Record<string, unknown>>(
  messages: readonly T[],
  turn: StoppedUserTurn,
  restoredText: (text: string, userTextFormat?: unknown) => string,
): T | undefined {
  const users = messages.filter((item) => item.role === "user").reverse();
  if (
    turn.clientMessageId &&
    users.some((item) => typeof item.clientMessageId === "string")
  )
    return users.find((item) => item.clientMessageId === turn.clientMessageId);
  return users.find(
    (item) =>
      typeof item.text === "string" &&
      restoredText(item.text, item.userTextFormat) === turn.text &&
      (typeof item.timestamp !== "number" ||
        item.timestamp >= turn.sentAt - STOPPED_TURN_CLOCK_SKEW_MS),
  );
}
