/**
 * Live voice-session registry — the SEC-6 "revoke-to-silence" backbone.
 *
 * The 120s JWT is only a bootstrap; once the WS is open the session lives on an
 * in-memory binding. Revoking/ending/deleting a session MUST sever the live
 * Deepgram Flux + Cartesia sockets in bounded time (<=500ms), from EITHER the
 * same worker (the disconnecting client) OR a different authenticated session
 * of the same owner (a second device / the dashboard).
 *
 * This registry provides the same-worker path directly: a revoke on the worker
 * that holds the socket invokes the registered `sever` synchronously, so
 * uplink to Deepgram stops in well under 500ms. The cross-worker path is closed
 * by the JWT revocation store (see `jwt.ts`): the live session polls the
 * revocation denylist and severs itself when its own `jti` appears, bounding
 * cross-worker propagation to the poll interval. Both routes end at the same
 * `sever` function, which the session wires to the adapters' `cancel()`.
 *
 * The registry is intentionally process-local. It is authoritative for "is this
 * session live on THIS worker" and nothing else; durability of the revoke
 * decision itself lives in Redis (`jwt.ts`), not here.
 */

export type VoiceSessionSeverReason =
  | "revoked"
  | "expired"
  | "completed"
  | "client_disconnect"
  | "error"
  | "quota_exhausted"
  | "idle_timeout"
  | "max_wallclock";

export interface LiveVoiceSession {
  readonly sessionId: string;
  readonly jti: string;
  readonly organizationId: string;
  readonly userId: string;
  /**
   * Sever the live provider sockets and tear the session down. MUST be
   * idempotent — it can be called by the client disconnect, a cross-device
   * revoke, expiry, and completion, in any order.
   */
  sever(reason: VoiceSessionSeverReason): void;
}

export interface VoiceSessionRegistry {
  register(session: LiveVoiceSession): void;
  unregister(sessionId: string): void;
  get(sessionId: string): LiveVoiceSession | undefined;
  /**
   * Sever a live session on THIS worker by id. Returns true if a live session
   * was found and severed here, false if not present on this worker (the
   * cross-worker path via the JWT revocation store then applies).
   */
  severBySessionId(sessionId: string, reason: VoiceSessionSeverReason): boolean;
  /** Sever by jti — the shape a revoke-by-token path uses. */
  severByJti(jti: string, reason: VoiceSessionSeverReason): boolean;
  /** Count of live sessions, for the per-worker concurrency ceiling. */
  size(): number;
}

class InProcessVoiceSessionRegistry implements VoiceSessionRegistry {
  private readonly bySessionId = new Map<string, LiveVoiceSession>();
  private readonly byJti = new Map<string, LiveVoiceSession>();

  register(session: LiveVoiceSession): void {
    // A re-register for the same id supersedes the old binding; sever the old
    // one so a reconnect can never leave two live sockets for one session.
    const existing = this.bySessionId.get(session.sessionId);
    if (existing && existing !== session) {
      this.bySessionId.delete(existing.sessionId);
      this.byJti.delete(existing.jti);
      existing.sever("error");
    }
    this.bySessionId.set(session.sessionId, session);
    this.byJti.set(session.jti, session);
  }

  unregister(sessionId: string): void {
    const session = this.bySessionId.get(sessionId);
    if (!session) return;
    this.bySessionId.delete(sessionId);
    this.byJti.delete(session.jti);
  }

  get(sessionId: string): LiveVoiceSession | undefined {
    return this.bySessionId.get(sessionId);
  }

  severBySessionId(sessionId: string, reason: VoiceSessionSeverReason): boolean {
    const session = this.bySessionId.get(sessionId);
    if (!session) return false;
    this.unregister(sessionId);
    session.sever(reason);
    return true;
  }

  severByJti(jti: string, reason: VoiceSessionSeverReason): boolean {
    const session = this.byJti.get(jti);
    if (!session) return false;
    this.unregister(session.sessionId);
    session.sever(reason);
    return true;
  }

  size(): number {
    return this.bySessionId.size;
  }
}

let sharedRegistry: VoiceSessionRegistry | null = null;

/**
 * The process-wide live-session registry. One per worker isolate — exactly the
 * scope where a same-worker sever is synchronous and instant.
 */
export function getVoiceSessionRegistry(): VoiceSessionRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new InProcessVoiceSessionRegistry();
  }
  return sharedRegistry;
}

/** Test-only: fresh registry so cases don't leak live sessions into each other. */
export function __resetVoiceSessionRegistryForTests(): void {
  sharedRegistry = new InProcessVoiceSessionRegistry();
}

/** Explicit constructor for tests that want an isolated instance. */
export function createVoiceSessionRegistry(): VoiceSessionRegistry {
  return new InProcessVoiceSessionRegistry();
}
