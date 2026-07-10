/**
 * Ambient segment store port + HTTP client (AMBIENT-MODE-DESIGN §3).
 *
 * Ambient mode has EXACTLY ONE transcript/segment store: the canonical
 * `pendant_sessions_v1` store behind the agent's `/api/pendant/sessions/*`
 * routes (packages/agent/src/api/pendant-session-routes.ts). Ambient does NOT
 * add a second store, a second lease system, or a second insight pipeline
 * (design §11). It commits Flux end-of-turn finals as pendant segments through
 * the EXISTING append path, which is the sole ordinal allocator.
 *
 * The cloud voice-session worker cannot import the agent's node-http route
 * module, so it reaches the store the way the design specifies: authenticated
 * HTTP calls to those routes. This module is that client, expressed behind a
 * narrow `AmbientSegmentStore` PORT so:
 *   - the ambient session depends on the port, not on fetch;
 *   - tests inject a fake store that drives the REAL ordinal/lease/state
 *     contract in-memory (no network), so the thing under test (ambient
 *     session lifecycle + segment ordering + pause-refuses-append) is real;
 *   - prod injects `createHttpPendantSegmentStore` pointed at the agent route.
 *
 * The store NEVER holds a provider key. The server-held authorization it
 * carries resolves the owner boundary at the agent (the pendant routes derive
 * `ownerId` from the authenticated `adminEntityId`, never the client).
 */

import {
  PendantMutationResponseSchema,
  PendantSessionSnapshotSchema,
  pendantSegmentId,
  type PendantSegment,
  type PendantSessionErrorCode,
  type PendantSessionSnapshot,
} from "@elizaos/shared/contracts";

export interface AmbientSegmentInput {
  /** Server-assigned by ordinal contiguity; the caller passes the NEXT ordinal. */
  ordinal: number;
  text: string;
  words: PendantSegment["words"];
  /** Authoritative Flux EOT => resolved; a forced cap-commit is also resolved. */
  status: PendantSegment["status"];
  confidence: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface AmbientAppendResult {
  segmentId: string;
  ordinal: number;
  revision: number;
  /** The full session revision after the append (for follower cursors). */
  sessionRevision: number;
  /** Contiguous segment count after commit (the next ordinal to allocate). */
  segmentCount: number;
}

export class AmbientStoreError extends Error {
  constructor(
    message: string,
    readonly code: PendantSessionErrorCode | "transport" | "protocol",
    readonly status?: number,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "AmbientStoreError";
  }
}

/**
 * Mint-time store operations (create/bind a pendant session + acquire the first
 * lease). Separated from the runtime `AmbientSegmentStore` so the mint route
 * depends only on what it uses, and the WS session only on append/state/renew.
 */
export interface AmbientSessionProvisioner {
  /**
   * Create a NEW canonical pendant session (processingLocation "cloud" — ambient
   * is unambiguously cloud, design §8.1). Returns its server-assigned id. Idem-
   * potent on a supplied id (the create route returns the existing session).
   */
  createSession(processingLocation: "cloud"): Promise<{ pendantSessionId: string }>;
  /**
   * Verify an EXISTING pendant session belongs to the authenticated owner (for
   * resume). Returns true if it exists+owned, false if not found (the store
   * derives owner server-side, so a cross-owner id 404s => false).
   */
  sessionExists(pendantSessionId: string): Promise<boolean>;
  /**
   * Acquire the FIRST capture lease at mint (holder = the ambient session id).
   * Returns the plaintext lease token + expiry; only the digest is stored.
   */
  acquireLease(
    pendantSessionId: string,
    holder: string,
    leaseMs: number,
  ): Promise<{ leaseToken: string; leaseExpiresAt: string }>;
}

/**
 * The narrow store surface the ambient session drives. Each method maps 1:1 to
 * an existing pendant route; there is no method here that is not already a
 * pendant route operation.
 */
export interface AmbientSegmentStore {
  /**
   * Read the current bound-session state the ambient session needs at start:
   * the committed segment count (so a RESUME initializes its next ordinal from
   * the existing segments, not 0) and whether the session is still writable
   * (active, not ended). Maps to the pendant snapshot GET route. Throws
   * `not_found` if the session is gone (a stale resume).
   */
  getSessionState(
    pendantSessionId: string,
  ): Promise<{ segmentCount: number; state: "active" | "paused" | "ended" }>;

  /**
   * Append a segment at `input.ordinal` using the current lease token. Returns
   * the canonical id + revision. Throws `AmbientStoreError` with a typed code
   * on lease/revision/paused/validation failures (the pendant route's own
   * error codes) so the session can react (e.g. paused => drop, lease_conflict
   * => stop writing).
   */
  appendSegment(
    pendantSessionId: string,
    leaseToken: string,
    input: AmbientSegmentInput,
  ): Promise<AmbientAppendResult>;

  /**
   * Flip the pendant session state via the existing pause/resume/end control
   * route. `pause` makes the store refuse subsequent appends (`assertCanAppend`
   * throws on paused), which is the persistence half of the pause guarantee;
   * the socket-sever half lives in the ambient session (severs Flux).
   */
  setState(
    pendantSessionId: string,
    state: "paused" | "active" | "ended",
  ): Promise<void>;

  /**
   * Renew the capture lease over the existing lease route ("renew existing
   * holder" branch). Returns the NEW plaintext lease token + expiry. The server
   * holds the current token; the client never sends it up (SEC-7).
   */
  renewLease(
    pendantSessionId: string,
    holder: string,
    currentLeaseToken: string,
    leaseMs: number,
  ): Promise<{ leaseToken: string; leaseExpiresAt: string }>;
}

// -------------------------------------------------------------------------
// HTTP implementation against the agent's /api/pendant/sessions/* routes.
// -------------------------------------------------------------------------

export interface HttpPendantStoreConfig {
  /** Base URL of the agent host serving the pendant routes (no trailing slash). */
  baseUrl: string;
  /** Server-held credential resolving the owner boundary at the agent. */
  authorization: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const PENDANT_PREFIX = "/api/pendant/sessions";

function segmentTemplate(input: AmbientSegmentInput): Record<string, unknown> {
  // The append route omits id/sessionId/createdAt/updatedAt (server-assigned)
  // and requires a revision-0 body for a NEW segment. Diarization stays
  // anonymous: speakerCluster/speakerAlias are always null in ambient (design
  // §3.3/§4.4 — never inferred).
  return {
    ordinal: input.ordinal,
    status: input.status,
    text: input.text,
    words: input.words,
    speakerCluster: null,
    speakerAlias: null,
    confidence: input.confidence,
    error: null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    revision: 0,
  };
}

interface PendantErrorBody {
  ok: false;
  error: { code: PendantSessionErrorCode; message: string; currentRevision?: number };
}

function isPendantErrorBody(v: unknown): v is PendantErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { error?: unknown }).error === "object"
  );
}

export function createHttpPendantSegmentStore(
  config: HttpPendantStoreConfig,
): AmbientSegmentStore & AmbientSessionProvisioner {
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");

  async function call(
    path: string,
    method: string,
    body: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: config.authorization,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new AmbientStoreError(
        `pendant store request failed: ${error instanceof Error ? error.message : String(error)}`,
        "transport",
      );
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // A non-JSON body on an error status is still a typed transport failure.
      if (!res.ok) {
        throw new AmbientStoreError(`pendant store HTTP ${res.status}`, "transport", res.status);
      }
      throw new AmbientStoreError("pendant store returned a non-JSON body", "protocol", res.status);
    }
    if (!res.ok) {
      if (isPendantErrorBody(json)) {
        throw new AmbientStoreError(
          json.error.message,
          json.error.code,
          res.status,
          json.error.currentRevision,
        );
      }
      throw new AmbientStoreError(`pendant store HTTP ${res.status}`, "transport", res.status);
    }
    return json;
  }

  return {
    async getSessionState(pendantSessionId) {
      const raw = await call(
        `${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}`,
        "GET",
        undefined,
      );
      // The snapshot GET returns { ok, changed, snapshot } (or { changed:false }
      // when afterRevision matches; we never pass afterRevision, so a snapshot is
      // always present for an existing session).
      const snap = (raw as { snapshot?: unknown }).snapshot;
      const parsed = PendantSessionSnapshotSchema.safeParse(snap);
      if (!parsed.success) {
        throw new AmbientStoreError("pendant snapshot response was malformed", "protocol");
      }
      return {
        segmentCount: parsed.data.segments.length,
        state: parsed.data.session.state,
      };
    },

    async createSession(processingLocation) {
      const raw = await call(PENDANT_PREFIX, "POST", { processingLocation });
      const parsed = PendantSessionSnapshotSchema.safeParse(
        (raw as { snapshot?: unknown }).snapshot,
      );
      if (!parsed.success) {
        throw new AmbientStoreError("pendant create response was malformed", "protocol");
      }
      return { pendantSessionId: parsed.data.session.id };
    },

    async sessionExists(pendantSessionId) {
      try {
        await call(`${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}`, "GET", undefined);
        return true;
      } catch (error) {
        if (error instanceof AmbientStoreError && error.code === "not_found") return false;
        throw error;
      }
    },

    async acquireLease(pendantSessionId, holder, leaseMs) {
      const raw = await call(
        `${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}/lease`,
        "POST",
        { holder, leaseMs },
      );
      const obj = raw as {
        leaseToken?: unknown;
        session?: { captureLease?: { expiresAt?: unknown } };
      };
      if (typeof obj.leaseToken !== "string") {
        throw new AmbientStoreError("lease acquire returned no token", "protocol");
      }
      const expiresAt = obj.session?.captureLease?.expiresAt;
      return {
        leaseToken: obj.leaseToken,
        leaseExpiresAt:
          typeof expiresAt === "string" ? expiresAt : new Date(Date.now() + leaseMs).toISOString(),
      };
    },

    async appendSegment(pendantSessionId, leaseToken, input) {
      const raw = await call(
        `${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}/segments`,
        "POST",
        { leaseToken, segment: segmentTemplate(input) },
      );
      const parsed = PendantMutationResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AmbientStoreError("pendant append response was malformed", "protocol");
      }
      const snapshot = parsed.data.snapshot;
      const expectedId = pendantSegmentId(pendantSessionId, input.ordinal);
      const segment =
        snapshot.segments.find((s) => s.id === expectedId) ??
        snapshot.segments[snapshot.segments.length - 1];
      if (!segment) {
        throw new AmbientStoreError("pendant append committed no segment", "protocol");
      }
      return {
        segmentId: segment.id,
        ordinal: segment.ordinal,
        revision: segment.revision,
        sessionRevision: snapshot.session.revision,
        segmentCount: snapshot.segments.length,
      };
    },

    async setState(pendantSessionId, state) {
      const action = state === "paused" ? "pause" : state === "active" ? "resume" : "end";
      await call(
        `${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}/${action}`,
        "POST",
        {},
      );
    },

    async renewLease(pendantSessionId, holder, currentLeaseToken, leaseMs) {
      const raw = await call(
        `${PENDANT_PREFIX}/${encodeURIComponent(pendantSessionId)}/lease`,
        "POST",
        { holder, leaseToken: currentLeaseToken, leaseMs },
      );
      const obj = raw as { leaseToken?: unknown; session?: { captureLease?: { expiresAt?: unknown } } };
      if (typeof obj.leaseToken !== "string") {
        throw new AmbientStoreError("lease renew returned no token", "protocol");
      }
      const expiresAt = obj.session?.captureLease?.expiresAt;
      return {
        leaseToken: obj.leaseToken,
        leaseExpiresAt: typeof expiresAt === "string" ? expiresAt : new Date(Date.now() + leaseMs).toISOString(),
      };
    },
  };
}

/** Re-export for tests that assert against the canonical snapshot schema. */
export { PendantSessionSnapshotSchema };
