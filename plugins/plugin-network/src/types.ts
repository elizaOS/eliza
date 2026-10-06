/**
 * Network plugin contracts. The plugin owns no state: every read and write goes
 * through a host-injected NetworkStore (in Cloud: the network domain services
 * over Hyperdrive; in the simulator: an in-memory store).
 */

export const NETWORK_CONTEXTS = ["network", "social", "settings"] as const;

export const NETWORK_MEMBER_STATES = [
  "open",
  "busy",
  "traveling",
  "paused",
] as const;
export type NetworkMemberState = (typeof NETWORK_MEMBER_STATES)[number];

export interface NetworkMemberContext {
  memberId: string;
  firstName: string;
  city: string;
  state: NetworkMemberState;
  stateUntil: string | null;
  /** Shareable profile facets only; private facets never reach the plugin. */
  facets: string[];
  activeItems: Array<{ kind: string; summary: string }>;
}

export interface SetStateInput {
  memberId: string;
  state: NetworkMemberState;
  until: string | null;
  note: string | null;
  idempotencyKey: string;
}

export interface SetStateExecution {
  eventId: string;
  previous: NetworkMemberState;
  current: NetworkMemberState;
  until: string | null;
  committedAt: Date;
  replayed: boolean;
}

export type NetworkSignalKind = "opt_out" | "travel" | "safety_concern";

export interface NetworkSignal {
  kind: NetworkSignalKind;
  evidence: string;
}

export interface NetworkStore {
  getMemberContext(memberId: string): Promise<NetworkMemberContext | null>;
  setState(input: SetStateInput): Promise<SetStateExecution>;
  recordSignals(input: {
    memberId: string;
    messageId: string;
    signals: NetworkSignal[];
  }): Promise<{ recorded: number }>;
}

/** Host-supplied, trusted turn authority. Never derived from model output. */
export interface NetworkTurnAuthority {
  memberId: string;
}
