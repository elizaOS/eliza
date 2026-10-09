/**
 * Network plugin contracts. The plugin owns no state: every read and write goes
 * through a host-injected NetworkStore (in Cloud: the network domain services
 * over Hyperdrive; in the simulator: an in-memory store).
 */
/**
 * PRD 7.2 participation states. Mirrors `ParticipationState` in packages/core/src/types.ts; kept
 * literal because this package must not import outside itself (Eliza Cloud installs a copy of
 * this directory alone, so a relative path into packages/core does not resolve there).
 */
export type ParticipationState =
  | "open"
  | "normal"
  | "quiet"
  | "receiving"
  | "paused";

export const NETWORK_CONTEXTS = ["network", "social", "settings"] as const;

export const NETWORK_MEMBER_STATES = [
  "open",
  "busy",
  "traveling",
  "paused",
] as const;
export type NetworkMemberState = (typeof NETWORK_MEMBER_STATES)[number];

/**
 * The plugin's member states mapped to the PRD 7.2 participation states in packages/core
 * (audit plugin-prototypes-10: the plugin, core and the connector used different words).
 * busy is "life is full right now" (Quiet). traveling holds intros for a window, so it is Paused
 * with from/until (PRD 16.1 presence windows). open ("back, send intros") is the default, Normal.
 * Stores translate with this table; nothing else may hard-code the mapping.
 */
export const NETWORK_STATE_TO_PARTICIPATION = {
  open: "normal",
  busy: "quiet",
  traveling: "paused",
  paused: "paused",
} as const satisfies Record<NetworkMemberState, ParticipationState>;

export interface NetworkMemberContext {
  memberId: string;
  firstName: string;
  city: string;
  state: NetworkMemberState;
  /** Start of a scheduled state window (e.g. travel next week); null = effective now. */
  stateFrom?: string | null;
  stateUntil: string | null;
  /** Shareable profile facets only; private facets never reach the plugin. */
  facets: string[];
  activeItems: Array<{ kind: string; summary: string }> | null;
}

export interface SetStateInput {
  memberId: string;
  state: NetworkMemberState;
  /** Window start (ISO); null = now. Presence windows: PRD 16.1-16.3, ME-011. */
  from?: string | null;
  until: string | null;
  note: string | null;
  idempotencyKey: string;
}

export interface SetStateExecution {
  /** Null when the request matched the current state and nothing was written. */
  eventId: string | null;
  previous: NetworkMemberState;
  current: NetworkMemberState;
  from?: string | null;
  until: string | null;
  committedAt: Date;
  replayed: boolean;
  /** True when state and until already matched: stores MUST NOT write an event in that case. */
  unchanged: boolean;
}

export type NetworkSignalKind = "opt_out" | "travel" | "safety_concern";

export interface NetworkSignal {
  kind: NetworkSignalKind;
  evidence: string;
}

/**
 * Unseen updates from the single inbox (packages/notify). Reading them marks them seen on every
 * surface, so no text follows for them. Summaries are member-safe lines already leak-checked by
 * the producer.
 */
export interface NetworkUpdatesRead {
  items: Array<{ summary: string }>;
}

export interface NetworkStore {
  getMemberContext(memberId: string): Promise<NetworkMemberContext | null>;
  /** Optional: hosts wired to the single inbox implement it, and GET_UPDATES is registered only then. */
  readUpdates?(memberId: string): Promise<NetworkUpdatesRead>;
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
  /**
   * The app (site) this turn runs in, e.g. "ntwrk.love" (audit judge-evals-7). Idempotency keys are
   * scoped by it, and stores and judges use it for cross-app checks. Hosts should always set it.
   */
  app?: string;
  /** The member's IANA time zone; dates in the member's words resolve on their local day. */
  timeZone?: string;
}

/**
 * Idempotency key for one state change. Scoped by app and member (audit plugin-prototypes-4):
 * a message id or client message id alone can repeat across members, and the store would
 * replay another member's change.
 */
export function setStateIdempotencyKey(
  authority: NetworkTurnAuthority,
  origin: string,
  ordinal: number,
): string {
  return `network:set_state:v2:${authority.app ?? "default"}:${authority.memberId}:${origin}:${ordinal}`;
}
