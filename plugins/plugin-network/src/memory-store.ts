/** Deterministic in-memory NetworkStore for unit tests and the simulator. */
import type {
  NetworkMemberContext,
  NetworkSignal,
  NetworkStore,
  SetStateExecution,
  SetStateInput,
} from "./types.js";

export class InMemoryNetworkStore implements NetworkStore {
  readonly members = new Map<string, NetworkMemberContext>();
  readonly events: Array<{ id: string; type: string; memberId: string; payload: unknown }> = [];
  readonly signals: Array<{ memberId: string; messageId: string; signal: NetworkSignal }> = [];
  private readonly ledger = new Map<string, { exec: SetStateExecution; payload: string }>();
  private seq = 0;

  constructor(
    members: NetworkMemberContext[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const m of members) this.members.set(m.memberId, structuredClone(m));
  }

  async getMemberContext(memberId: string): Promise<NetworkMemberContext | null> {
    const m = this.members.get(memberId);
    return m ? structuredClone(m) : null;
  }

  async setState(input: SetStateInput): Promise<SetStateExecution> {
    // Same key + different payload is a conflict, never a replay of someone else's change
    // (audit plugin-prototypes-4). Cloud's store must do the same.
    const payload = JSON.stringify([input.memberId, input.state, input.from ?? null, input.until ?? null]);
    const prior = this.ledger.get(input.idempotencyKey);
    if (prior) {
      if (prior.payload !== payload) throw new Error(`idempotency key reused with a different payload: ${input.idempotencyKey}`);
      return { ...prior.exec, replayed: true };
    }
    const member = this.members.get(input.memberId);
    if (!member) throw new Error(`unknown member ${input.memberId}`);
    const previous = member.state;
    const from = input.from ?? null;
    if (previous === input.state && (member.stateFrom ?? null) === from && (member.stateUntil ?? null) === (input.until ?? null)) {
      const noop: SetStateExecution = {
        eventId: null, previous, current: previous, from, until: input.until,
        committedAt: this.now(), replayed: false, unchanged: true,
      };
      this.ledger.set(input.idempotencyKey, { exec: noop, payload });
      return noop;
    }
    member.state = input.state;
    member.stateFrom = from;
    member.stateUntil = input.until;
    this.seq += 1;
    const eventId = `evt-${String(this.seq).padStart(6, "0")}`;
    this.events.push({
      id: eventId,
      type: "member.state_changed",
      memberId: input.memberId,
      payload: { previous, current: input.state, from, until: input.until, note: input.note },
    });
    const exec: SetStateExecution = {
      eventId,
      previous,
      current: input.state,
      from,
      until: input.until,
      committedAt: this.now(),
      replayed: false,
      unchanged: false,
    };
    this.ledger.set(input.idempotencyKey, { exec, payload });
    return exec;
  }

  async recordSignals(input: {
    memberId: string;
    messageId: string;
    signals: NetworkSignal[];
  }): Promise<{ recorded: number }> {
    for (const signal of input.signals) {
      this.signals.push({ memberId: input.memberId, messageId: input.messageId, signal });
    }
    return { recorded: input.signals.length };
  }
}
