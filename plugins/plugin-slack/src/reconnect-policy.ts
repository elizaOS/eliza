/**
 * Socket Mode reconnect policy and liveness tracking.
 *
 * Bolt reconnects on its own, which is fine for the case it was designed for
 * (a transient network blip) and actively harmful for the case that actually
 * pages people: a credential that has stopped working. A revoked bot token, a
 * deactivated account, or a removed scope will never start succeeding, so a
 * reconnect loop against one is an infinite loop — it burns Slack rate limit,
 * fills logs with identical failures, and, worst of all, *looks* like the
 * connector is trying to recover when it is permanently dead. Nobody gets
 * told; the agent just goes quiet.
 *
 * So this module draws one hard line: recoverable errors get bounded,
 * jittered backoff; non-recoverable auth errors stop the loop immediately and
 * surface a diagnosis.
 *
 * Liveness is the other half. "Connected" is not "working" — a Socket Mode
 * connection can sit open and silent after a half-close, and the socket layer
 * is perfectly happy. Tracking `lastEventAt` separately from `lastConnectedAt`
 * is what lets a health check tell a quiet workspace apart from a wedged one,
 * which is exactly the distinction that matters at 3am.
 */

/**
 * Slack error codes that will never succeed on retry.
 *
 * Each is a permanent statement about the credential, not the network:
 * the token was revoked, the account was deactivated, the scope was never
 * granted. Retrying any of them is a busy-loop against a wall.
 */
const NON_RECOVERABLE_SLACK_AUTH_ERROR =
  /\b(account_inactive|invalid_auth|token_revoked|token_expired|not_authed|no_permission|org_login_required|team_access_not_granted|missing_scope|invalid_token|app_uninstalled)\b/i;

export interface SlackReconnectPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Fraction of the base delay added as random jitter, 0..1. */
  jitter: number;
  /** Attempt ceiling; `0` means unbounded. */
  maxAttempts: number;
}

/**
 * 2s → 30s over ~8 attempts, 12 attempts total (~4 minutes of trying).
 * Jitter is what keeps a fleet of agents from stampeding Slack in lockstep
 * after a shared outage.
 */
export const SLACK_SOCKET_RECONNECT_POLICY: SlackReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

/**
 * Exponential backoff with additive jitter, clamped to `maxMs`.
 * `attempt` is 1-based: the first retry waits `initialMs`.
 */
export function computeSlackBackoffMs(
  policy: SlackReconnectPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/** Normalises any thrown value into a message string for matching/logging. */
export function formatSlackError(error: unknown): string {
  if (error instanceof Error) {
    const data = (error as { data?: { error?: unknown } }).data;
    const slackCode =
      data && typeof data === "object" && typeof data.error === "string"
        ? data.error
        : "";
    return slackCode ? `${error.message} (${slackCode})` : error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const raw = error as { error?: unknown; message?: unknown };
    if (typeof raw.error === "string") {
      return raw.error;
    }
    if (typeof raw.message === "string") {
      return raw.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "unknown error";
    }
  }
  return "unknown error";
}

/**
 * True when an error means the credential is permanently unusable.
 *
 * The check reads the structured `data.error` Slack sets on `WebAPIPlatformError`
 * as well as the message text, so it works whether the error came back from a
 * web API call or a socket start failure.
 */
export function isNonRecoverableSlackAuthError(error: unknown): boolean {
  return NON_RECOVERABLE_SLACK_AUTH_ERROR.test(formatSlackError(error));
}

export type SlackReconnectDecision =
  | { action: "retry"; attempt: number; delayMs: number }
  | { action: "abort"; attempt: number; reason: "auth"; message: string }
  | {
      action: "abort";
      attempt: number;
      reason: "exhausted";
      message: string;
    };

/**
 * Single decision point for "the socket just died, now what".
 *
 * Auth is checked before the attempt ceiling deliberately: an operator whose
 * token was revoked should be told *that*, not "max attempts reached", which
 * would send them looking at their network.
 */
export function decideSlackReconnect(params: {
  error: unknown;
  attempt: number;
  policy?: SlackReconnectPolicy;
  random?: () => number;
}): SlackReconnectDecision {
  const policy = params.policy ?? SLACK_SOCKET_RECONNECT_POLICY;
  const attempt = params.attempt;

  if (isNonRecoverableSlackAuthError(params.error)) {
    return {
      action: "abort",
      attempt,
      reason: "auth",
      message: `Slack socket mode hit a non-recoverable auth error; not reconnecting (${formatSlackError(params.error)}). Check the bot/app tokens and granted scopes.`,
    };
  }

  if (policy.maxAttempts > 0 && attempt >= policy.maxAttempts) {
    return {
      action: "abort",
      attempt,
      reason: "exhausted",
      message: `Slack socket mode reconnect gave up after ${attempt}/${policy.maxAttempts} attempts (${formatSlackError(params.error)}).`,
    };
  }

  return {
    action: "retry",
    attempt,
    delayMs: computeSlackBackoffMs(policy, attempt, params.random),
  };
}

export type SlackHealthState =
  | "connecting"
  | "healthy"
  | "degraded"
  | "disconnected"
  | "failed";

export interface SlackLivenessSnapshot {
  connected: boolean;
  healthState: SlackHealthState;
  lastConnectedAt: number | null;
  /** Last time *any* inbound event was seen. The real liveness signal. */
  lastEventAt: number | null;
  lastDisconnectedAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  /** Set when the connector stopped permanently, e.g. a revoked token. */
  permanentFailure: string | null;
}

export interface SlackLivenessOptions {
  /**
   * Silence after which a connected socket is reported `degraded`.
   * Default 15 minutes: long enough that a genuinely quiet channel does not
   * trip it, short enough to catch a wedged socket within one on-call glance.
   */
  stalenessMs?: number;
  now?: () => number;
}

const DEFAULT_STALENESS_MS = 15 * 60_000;

/**
 * Per-account liveness tracker.
 *
 * Kept deliberately dumb — it records timestamps and derives a state. All the
 * policy lives in `snapshot()`, so callers cannot disagree about what
 * "healthy" means.
 */
export class SlackLivenessTracker {
  private connected = false;
  private lastConnectedAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastDisconnectedAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private permanentFailure: string | null = null;
  private readonly stalenessMs: number;
  private readonly now: () => number;

  constructor(options: SlackLivenessOptions = {}) {
    this.stalenessMs = options.stalenessMs ?? DEFAULT_STALENESS_MS;
    this.now = options.now ?? (() => Date.now());
  }

  markConnected(): void {
    this.connected = true;
    this.lastConnectedAt = this.now();
    this.lastError = null;
    this.permanentFailure = null;
    this.reconnectAttempts = 0;
    // Note: `lastEventAt` is deliberately NOT seeded here. Connecting is not
    // evidence of traffic, and seeding it would paper over exactly the wedged
    // -socket case this tracker exists to catch.
  }

  markDisconnected(error?: unknown): void {
    this.connected = false;
    this.lastDisconnectedAt = this.now();
    if (error !== undefined) {
      this.lastError = formatSlackError(error);
    }
  }

  /** Called on every inbound event, before any gating. */
  markEvent(): void {
    this.lastEventAt = this.now();
  }

  markReconnectAttempt(attempt: number): void {
    this.reconnectAttempts = attempt;
  }

  markPermanentFailure(message: string): void {
    this.connected = false;
    this.permanentFailure = message;
    this.lastError = message;
    this.lastDisconnectedAt = this.now();
  }

  snapshot(): SlackLivenessSnapshot {
    return {
      connected: this.connected,
      healthState: this.deriveHealthState(),
      lastConnectedAt: this.lastConnectedAt,
      lastEventAt: this.lastEventAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      permanentFailure: this.permanentFailure,
    };
  }

  private deriveHealthState(): SlackHealthState {
    if (this.permanentFailure) {
      return "failed";
    }
    if (!this.connected) {
      return this.lastConnectedAt === null ? "connecting" : "disconnected";
    }
    // Connected but silent for longer than the staleness window, having
    // previously seen traffic: the socket is open and probably not delivering.
    if (
      this.lastEventAt !== null &&
      this.now() - this.lastEventAt > this.stalenessMs
    ) {
      return "degraded";
    }
    return "healthy";
  }
}
