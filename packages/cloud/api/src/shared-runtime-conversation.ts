/**
 * Strongly ordered conversation state for shared-runtime agent turns.
 *
 * One Durable Object is addressed per agent room. Its local storage is the
 * request-path source of truth; Postgres is read only for one-time migration
 * and updated asynchronously as a recoverable reporting/backup mirror.
 */

import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import type { CachedAgentSandbox } from "@/lib/services/shared-runtime/cached-agent-dates";
import type { SharedTurnMessage } from "@/lib/services/shared-runtime/run-shared-agent-turn";
import type { SharedRuntimeAgent } from "@/lib/services/shared-runtime/shared-runtime-agent";
import type {
  SharedRuntimeHistoryStore,
  SharedTurnClaimStore,
  SharedTurnTerminalResult,
} from "@/lib/services/shared-runtime/shared-runtime-chat";
import {
  MAX_HISTORY_MESSAGES,
  mergeSharedRuntimeHistoryMessages,
  selectSharedRuntimeContext,
} from "@/lib/services/shared-runtime/shared-runtime-history-policy";
import type { AppEnv } from "@/types/cloud-worker-env";

// The agent row crosses the Durable Object boundary as JSON, so its Drizzle
// `Date` columns arrive as ISO strings; `handle` rehydrates them before any
// service consumes the row (the CONVERSATIONS-500 defect class).
type ConversationRequest =
  | { operation: "bridge"; agent: CachedAgentSandbox; rpc: BridgeRequest }
  | {
      operation: "personal-bridge";
      agent: SharedRuntimeAgent;
      rpc: BridgeRequest;
    }
  | { operation: "stream"; agent: CachedAgentSandbox; rpc: BridgeRequest }
  | {
      operation: "personal-stream";
      agent: SharedRuntimeAgent;
      rpc: BridgeRequest;
    }
  | {
      operation: "prewarm";
      agentId: string;
      roomId: string;
      startEmpty?: boolean;
    }
  | { operation: "history"; agentId: string; roomId: string }
  | {
      operation: "cutover-seal";
      agentId: string;
      roomId: string;
      token: string;
      leaseMs: number;
      organizationId: string;
      dedicatedAgentId: string;
    }
  | { operation: "cutover-release"; token: string }
  | { operation: "cutover-commit"; token: string }
  | {
      operation: "provisional-convergence-reserve";
      agentId: string;
      token: string;
      holderId: string;
      leaseMs: number;
    }
  | {
      operation: "provisional-convergence-seal";
      agentId: string;
      token: string;
      holderId: string;
      targetAgentId: string;
      targetUserId: string;
      targetOrganizationId: string;
      leaseMs: number;
    }
  | {
      operation: "provisional-convergence-import";
      agentId: string;
      token: string;
      holderId: string;
      history: SharedTurnMessage[];
    }
  | {
      operation: "provisional-convergence-alias";
      token: string;
      targetAgentId: string;
      targetUserId: string;
      targetOrganizationId: string;
    }
  | {
      operation: "provisional-convergence-release";
      token: string;
      holderId: string;
    }
  | { operation: "delete"; agentId: string };

interface StoredConversation {
  agentId: string;
  channelId: string;
  history: SharedTurnMessage[];
  recall?: SharedTurnMessage[];
  dirty: boolean;
  version: number;
}

const CONVERSATION_KEY = "conversation";
const HISTORY_ARCHIVE_PREFIX = "history-archive:";
const MAX_RECALL_MESSAGES = 128;
const CUTOVER_SEAL_KEY = "personal-cutover-seal";
const PROVISIONAL_CONVERGENCE_SEAL_KEY =
  "personal-provisional-convergence-seal";
const PROVISIONAL_CONVERGENCE_RESERVATION_KEY =
  "personal-provisional-convergence-reservation";
const PROVISIONAL_CONVERGENCE_ALIAS_KEY =
  "personal-provisional-convergence-alias";
const PROVISIONAL_CONVERGENCE_IMPORT_PREFIX =
  "personal-provisional-convergence-import:";
const RETRY_DELAY_MS = 30_000;

interface StoredCutoverSeal {
  token: string;
  expiresAt: number;
  committed: boolean;
  organizationId?: string;
  sourceAgentId?: string;
  dedicatedAgentId?: string;
}

interface StoredProvisionalConvergenceSeal {
  token: string;
  holderIds: string[];
  targetAgentId: string;
  targetUserId: string;
  targetOrganizationId: string;
  expiresAt: number;
}

interface StoredProvisionalConvergenceReservation {
  token: string;
  holderIds: string[];
  expiresAt: number;
}

interface StoredProvisionalConvergenceAlias {
  token: string;
  targetAgentId: string;
  targetUserId: string;
  targetOrganizationId: string;
}

/**
 * Durable claim ledger for client-keyed turns (#18045), stored as one bounded
 * value. The room queue fully serializes turns, so read-modify-write is safe.
 * Bounds keep the value under the storage limit; an evicted claim degrades to
 * a fresh execution whose deterministic billing identities still dedupe the
 * charge at the admission gate.
 */
const TURN_CLAIMS_KEY = "turn-claims";
// ponytail: single bounded value = ~32-turn replay window; per-claim rows if a room ever needs more.
const MAX_TURN_CLAIMS = 32;
const MAX_TURN_CLAIMS_BYTES = 256_000;

interface StoredTurnClaim {
  key: string;
  hash: string;
  result?: SharedTurnTerminalResult;
}

function boundTurnClaims(claims: StoredTurnClaim[]): StoredTurnClaim[] {
  let bounded = claims.slice(-MAX_TURN_CLAIMS);
  while (
    bounded.length > 1 &&
    new TextEncoder().encode(JSON.stringify(bounded)).length >
      MAX_TURN_CLAIMS_BYTES
  ) {
    bounded = bounded.slice(1);
  }
  return bounded;
}

/**
 * SQLite-backed Durable Object storage rejects values over 2 MiB. History is
 * count-capped upstream (MAX_HISTORY_MESSAGES) but individual message text is
 * unbounded, so trim oldest turns — and as a last resort truncate the sole
 * remaining message — to keep the snapshot storable; otherwise every
 * subsequent save would throw and wedge the room.
 */
const MAX_SNAPSHOT_BYTES = 1_500_000;

function snapshotBytes(history: SharedTurnMessage[]): number {
  return new TextEncoder().encode(JSON.stringify(history)).length;
}

function boundSnapshotHistory(
  history: SharedTurnMessage[],
): SharedTurnMessage[] {
  let bounded = history;
  while (bounded.length > 1 && snapshotBytes(bounded) > MAX_SNAPSHOT_BYTES) {
    bounded = bounded.slice(1);
  }
  if (bounded.length === 1 && snapshotBytes(bounded) > MAX_SNAPSHOT_BYTES) {
    // Slice by code units at a quarter of the byte budget: UTF-8 expands a
    // code unit to at most ~3 bytes, so the result stays well under the cap.
    const only = bounded[0];
    bounded = [
      { ...only, content: only.content.slice(0, MAX_SNAPSHOT_BYTES / 4) },
    ];
  }
  return bounded;
}

function archiveMessageKey(message: SharedTurnMessage): string {
  const identity =
    message.id ??
    `${message.role}:${message.createdAt ?? 0}:${message.content}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${HISTORY_ARCHIVE_PREFIX}${(message.createdAt ?? 0)
    .toString()
    .padStart(16, "0")}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

class ConversationCacheWarmingError extends Error {
  constructor() {
    super("Conversation cache is warming. Retry shortly.");
    this.name = "ConversationCacheWarmingError";
  }
}

export class SharedRuntimeConversation {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private conversation: StoredConversation | null | undefined;
  private hydration: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private mirrorQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: AppEnv["Bindings"]) {
    this.state = state;
    this.env = env;
  }

  private async runWithBindings<T>(fn: () => Promise<T>): Promise<T> {
    const [{ runWithDbCacheAsync }, { runWithCloudBindingsAsync }] =
      await Promise.all([
        import("@/db/client"),
        import("@/lib/runtime/cloud-bindings"),
      ]);
    return await runWithCloudBindingsAsync(this.env, async () =>
      runWithDbCacheAsync(fn),
    );
  }

  private async loadConversation(
    agentId: string,
    channelId: string,
    startEmpty: boolean,
  ): Promise<StoredConversation> {
    if (this.conversation) return this.conversation;
    if (this.conversation === undefined) {
      this.conversation =
        (await this.state.storage.get<StoredConversation>(CONVERSATION_KEY)) ??
        null;
    }
    if (this.conversation) return this.conversation;

    // A personal identity has no sandbox-era Postgres history to migrate. Its
    // Durable Object is born on first contact, so delaying that first reply for
    // a mirror read would turn a successful Telegram webhook into silent loss.
    if (startEmpty) {
      this.conversation = {
        agentId,
        channelId,
        history: [],
        dirty: false,
        version: 0,
      };
      await this.state.storage.put(CONVERSATION_KEY, this.conversation);
      return this.conversation;
    }

    if (!this.hydration) {
      this.hydration = this.runWithBindings(async () => {
        const { sharedRuntimeHistoryRepository } = await import(
          "@/db/repositories/shared-runtime-history"
        );
        const history = await sharedRuntimeHistoryRepository.get(
          agentId,
          channelId,
        );
        this.conversation = {
          agentId,
          channelId,
          history,
          dirty: false,
          version: 0,
        };
        await this.state.storage.put(CONVERSATION_KEY, this.conversation);
      })
        .catch(async (error) => {
          // error-policy:J7 a failed migration leaves the request fail-closed;
          // a later retry starts a fresh hydration instead of losing history.
          const { logger } = await import("@/lib/utils/logger");
          logger.warn("[SharedRuntimeConversation] history hydration failed", {
            agentId,
            channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.hydration = undefined;
        });
      this.state.waitUntil(this.hydration);
    }
    throw new ConversationCacheWarmingError();
  }

  /**
   * Join cold history hydration and load the modules used at turn ingress.
   * This is deliberately read-only: voice startup can pay the exact room's
   * initialization cost under its fixed greeting without landing a fake turn.
   */
  private async prewarmConversation(
    agentId: string,
    channelId: string,
    startEmpty: boolean,
  ): Promise<void> {
    try {
      await this.loadConversation(agentId, channelId, startEmpty);
    } catch (error) {
      if (!(error instanceof ConversationCacheWarmingError)) throw error;
      const hydration = this.hydration;
      if (hydration) await hydration;
    }
    if (!this.conversation) {
      throw new Error("Conversation prewarm failed to hydrate history.");
    }
    await this.runWithBindings(async () => {
      await Promise.all([
        import("@/lib/services/shared-runtime/shared-runtime-chat"),
        import("@/lib/services/shared-runtime/cached-agent-dates"),
      ]);
    });
  }

  private async mirrorConversation(
    snapshot: StoredConversation,
  ): Promise<void> {
    try {
      await this.runWithBindings(async () => {
        const { sharedRuntimeHistoryRepository } = await import(
          "@/db/repositories/shared-runtime-history"
        );
        await sharedRuntimeHistoryRepository.merge(
          snapshot.agentId,
          snapshot.channelId,
          snapshot.history,
          MAX_HISTORY_MESSAGES,
        );
      });
      const current =
        await this.state.storage.get<StoredConversation>(CONVERSATION_KEY);
      if (
        current?.dirty &&
        current.agentId === snapshot.agentId &&
        current.channelId === snapshot.channelId &&
        current.version === snapshot.version
      ) {
        this.conversation = { ...current, dirty: false };
        await this.state.storage.put(CONVERSATION_KEY, this.conversation);
      }
    } catch (error) {
      // error-policy:J7 the Durable Object copy is authoritative for active
      // chat; a failed reporting mirror is retried by alarm and must not kill
      // or delay the user-visible turn.
      const { logger } = await import("@/lib/utils/logger");
      logger.warn("[SharedRuntimeConversation] Postgres mirror failed", {
        agentId: snapshot.agentId,
        channelId: snapshot.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
    }
  }

  private scheduleMirror(snapshot: StoredConversation): Promise<void> {
    this.mirrorQueue = this.mirrorQueue.then(() =>
      this.mirrorConversation(snapshot),
    );
    this.state.waitUntil(this.mirrorQueue);
    return this.mirrorQueue;
  }

  private async loadArchivedHistory(): Promise<SharedTurnMessage[]> {
    const archived = await this.state.storage.list<SharedTurnMessage>({
      prefix: HISTORY_ARCHIVE_PREFIX,
    });
    return [...archived.values()];
  }

  private async loadCompleteHistory(
    current: StoredConversation,
  ): Promise<SharedTurnMessage[]> {
    const archived = await this.loadArchivedHistory();
    return mergeSharedRuntimeHistoryMessages(
      archived,
      current.history,
      Number.MAX_SAFE_INTEGER,
    );
  }

  private historyStore(startEmpty: boolean): SharedRuntimeHistoryStore {
    return {
      load: async (agentId, channelId, queryText) => {
        const current = await this.loadConversation(
          agentId,
          channelId,
          startEmpty,
        );
        if (!startEmpty) return current.history;
        if (queryText === undefined) {
          return await this.loadCompleteHistory(current);
        }
        const recallContext = mergeSharedRuntimeHistoryMessages(
          current.recall ?? [],
          current.history,
          Number.MAX_SAFE_INTEGER,
        );
        return selectSharedRuntimeContext(
          recallContext,
          queryText,
          MAX_HISTORY_MESSAGES,
        );
      },
      merge: async (agentId, channelId, messages) => {
        const current = await this.loadConversation(
          agentId,
          channelId,
          startEmpty,
        );
        const merged = mergeSharedRuntimeHistoryMessages(
          current.history,
          messages,
          Number.MAX_SAFE_INTEGER,
        );
        const evicted = merged.slice(0, -MAX_HISTORY_MESSAGES);
        let recall = current.recall;
        if (startEmpty && evicted.length > 0) {
          for (const message of evicted) {
            await this.state.storage.put(archiveMessageKey(message), message);
          }
          recall = selectSharedRuntimeContext(
            mergeSharedRuntimeHistoryMessages(
              current.recall ?? [],
              evicted,
              Number.MAX_SAFE_INTEGER,
            ),
            "",
            MAX_RECALL_MESSAGES,
          );
        }
        const snapshot: StoredConversation = {
          agentId,
          channelId,
          history: boundSnapshotHistory(merged.slice(-MAX_HISTORY_MESSAGES)),
          ...(recall ? { recall } : {}),
          dirty: true,
          version: (this.conversation?.version ?? 0) + 1,
        };
        // Durable write FIRST: cancellation finalizers must be retryable. A
        // failed put leaves the prior in-memory state untouched so the same
        // response-body cancel/finalize path can attempt the write again.
        await this.state.storage.put(CONVERSATION_KEY, snapshot);
        this.conversation = snapshot;
        this.scheduleMirror(snapshot);
        return snapshot.history;
      },
    };
  }

  private turnClaims(): SharedTurnClaimStore {
    return {
      claim: async (key, payloadHash) => {
        const claims =
          (await this.state.storage.get<StoredTurnClaim[]>(TURN_CLAIMS_KEY)) ??
          [];
        const existing = claims.find((claim) => claim.key === key);
        if (existing) {
          if (existing.hash !== payloadHash) return { state: "conflict" };
          if (existing.result) {
            return { state: "replay", result: existing.result };
          }
          // Pending claim with a matching payload: the prior execution failed
          // before landing (the room queue serializes turns, so nothing is in
          // flight) — re-execution under the same claim is the recovery path.
          return { state: "claimed" };
        }
        await this.state.storage.put(
          TURN_CLAIMS_KEY,
          boundTurnClaims([...claims, { key, hash: payloadHash }]),
        );
        return { state: "claimed" };
      },
      complete: async (key, result) => {
        const claims =
          (await this.state.storage.get<StoredTurnClaim[]>(TURN_CLAIMS_KEY)) ??
          [];
        await this.state.storage.put(
          TURN_CLAIMS_KEY,
          boundTurnClaims(
            claims.map((claim) =>
              claim.key === key ? { ...claim, result } : claim,
            ),
          ),
        );
      },
    };
  }

  private async activeCutoverSeal(): Promise<StoredCutoverSeal | null> {
    const seal =
      (await this.state.storage.get<StoredCutoverSeal>(CUTOVER_SEAL_KEY)) ??
      null;
    // A pending lease expires so a crashed migration cannot strand Shared.
    // A committed seal is the durable cutover authority: expiring it would let
    // a stale browser/native session resume the archived Shared transcript.
    if (!seal || seal.committed || seal.expiresAt > Date.now()) return seal;

    // The DB marker commits before the final DO transition. If the Worker
    // crashes or loses the acknowledgement between those two durable writes,
    // an expired lease must recover the server-owned marker rather than
    // reopening Shared and splitting later turns into the archived log.
    if (seal.organizationId && seal.sourceAgentId && seal.dedicatedAgentId) {
      const organizationId = seal.organizationId;
      const sourceAgentId = seal.sourceAgentId;
      const active = await this.runWithBindings(async () => {
        const { findActivePersonalDedicatedTarget } = await import(
          "@/lib/services/agent-tier-upgrade-target"
        );
        return await findActivePersonalDedicatedTarget(
          organizationId,
          sourceAgentId,
        );
      });
      if (active?.id === seal.dedicatedAgentId) {
        const recovered = { ...seal, committed: true };
        await this.state.storage.put(CUTOVER_SEAL_KEY, recovered);
        return recovered;
      }
    }
    await this.state.storage.delete(CUTOVER_SEAL_KEY);
    return null;
  }

  private async activeProvisionalConvergenceSeal(): Promise<StoredProvisionalConvergenceSeal | null> {
    const seal =
      (await this.state.storage.get<StoredProvisionalConvergenceSeal>(
        PROVISIONAL_CONVERGENCE_SEAL_KEY,
      )) ?? null;
    if (!seal || seal.expiresAt > Date.now()) return seal;
    await this.state.storage.delete(PROVISIONAL_CONVERGENCE_SEAL_KEY);
    return null;
  }

  private async activeProvisionalConvergenceReservation(): Promise<StoredProvisionalConvergenceReservation | null> {
    const reservation =
      (await this.state.storage.get<StoredProvisionalConvergenceReservation>(
        PROVISIONAL_CONVERGENCE_RESERVATION_KEY,
      )) ?? null;
    if (!reservation || reservation.expiresAt > Date.now()) return reservation;
    await this.state.storage.delete(PROVISIONAL_CONVERGENCE_RESERVATION_KEY);
    return null;
  }

  private async forwardToConvergedPersonalEliza(
    payload: ConversationRequest,
    alias: StoredProvisionalConvergenceAlias,
    signal: AbortSignal,
  ): Promise<Response> {
    const namespace = this.env.SHARED_RUNTIME_CONVERSATIONS;
    if (!namespace) {
      throw new Error(
        "Shared runtime namespace is unavailable for personal history alias",
      );
    }

    let forwarded: ConversationRequest = payload;
    if (
      payload.operation === "personal-bridge" ||
      payload.operation === "personal-stream"
    ) {
      forwarded = {
        ...payload,
        agent: {
          ...payload.agent,
          id: alias.targetAgentId,
          user_id: alias.targetUserId,
          organization_id: alias.targetOrganizationId,
        },
        rpc: {
          ...payload.rpc,
          params: {
            ...payload.rpc.params,
            roomId: alias.targetAgentId,
          },
        },
      };
    } else if (
      payload.operation === "prewarm" ||
      payload.operation === "history" ||
      payload.operation === "cutover-seal"
    ) {
      forwarded = {
        ...payload,
        agentId: alias.targetAgentId,
        roomId: alias.targetAgentId,
      };
    }

    return await namespace
      .getByName(`${alias.targetAgentId}:${alias.targetAgentId}`)
      .fetch("https://shared-runtime.internal/converged-personal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwarded),
        signal,
      });
  }

  private async handle(request: Request): Promise<Response> {
    const payload = (await request.json()) as ConversationRequest;
    const personal =
      payload.operation === "personal-bridge" ||
      payload.operation === "personal-stream" ||
      ("agentId" in payload &&
        typeof payload.agentId === "string" &&
        payload.agentId.startsWith("personal:"));
    const historyStore = this.historyStore(personal);
    const turnClaims = this.turnClaims();
    if (payload.operation === "provisional-convergence-reserve") {
      if (
        typeof payload.agentId !== "string" ||
        !payload.agentId.startsWith("personal:") ||
        typeof payload.token !== "string" ||
        payload.token.length === 0 ||
        typeof payload.holderId !== "string" ||
        payload.holderId.length === 0 ||
        typeof payload.leaseMs !== "number" ||
        !Number.isFinite(payload.leaseMs) ||
        payload.leaseMs <= 0
      ) {
        return Response.json(
          { success: false, code: "invalid_provisional_convergence" },
          { status: 400 },
        );
      }
      const cutover = await this.activeCutoverSeal();
      if (cutover) {
        return Response.json(
          {
            success: false,
            code: cutover.committed
              ? "personal_eliza_dedicated"
              : "personal_cutover_in_progress",
          },
          { status: cutover.committed ? 409 : 423 },
        );
      }
      if (await this.activeProvisionalConvergenceSeal()) {
        return Response.json(
          { success: false, code: "provisional_convergence_in_progress" },
          { status: 423 },
        );
      }
      const existing = await this.activeProvisionalConvergenceReservation();
      if (existing && existing.token !== payload.token) {
        return Response.json(
          { success: false, code: "provisional_convergence_in_progress" },
          { status: 423 },
        );
      }
      await this.state.storage.put(PROVISIONAL_CONVERGENCE_RESERVATION_KEY, {
        token: payload.token,
        holderIds: [
          ...new Set([...(existing?.holderIds ?? []), payload.holderId]),
        ],
        expiresAt: Math.max(
          existing?.expiresAt ?? 0,
          Date.now() + payload.leaseMs,
        ),
      } satisfies StoredProvisionalConvergenceReservation);
      return Response.json({ success: true });
    }
    if (payload.operation === "provisional-convergence-seal") {
      if (
        typeof payload.agentId !== "string" ||
        !payload.agentId.startsWith("personal:") ||
        typeof payload.targetAgentId !== "string" ||
        !payload.targetAgentId.startsWith("personal:") ||
        payload.agentId === payload.targetAgentId ||
        typeof payload.targetUserId !== "string" ||
        payload.targetUserId.length === 0 ||
        typeof payload.targetOrganizationId !== "string" ||
        payload.targetOrganizationId.length === 0 ||
        typeof payload.token !== "string" ||
        payload.token.length === 0 ||
        typeof payload.holderId !== "string" ||
        payload.holderId.length === 0 ||
        typeof payload.leaseMs !== "number" ||
        !Number.isFinite(payload.leaseMs) ||
        payload.leaseMs <= 0
      ) {
        return Response.json(
          { success: false, code: "invalid_provisional_convergence" },
          { status: 400 },
        );
      }
      const cutover = await this.activeCutoverSeal();
      if (cutover) {
        return Response.json(
          {
            success: false,
            code: cutover.committed
              ? "personal_eliza_dedicated"
              : "personal_cutover_in_progress",
          },
          { status: cutover.committed ? 409 : 423 },
        );
      }
      if (await this.activeProvisionalConvergenceReservation()) {
        return Response.json(
          { success: false, code: "provisional_convergence_in_progress" },
          { status: 423 },
        );
      }
      const alias =
        await this.state.storage.get<StoredProvisionalConvergenceAlias>(
          PROVISIONAL_CONVERGENCE_ALIAS_KEY,
        );
      if (alias) {
        if (
          alias.token !== payload.token ||
          alias.targetAgentId !== payload.targetAgentId ||
          alias.targetUserId !== payload.targetUserId ||
          alias.targetOrganizationId !== payload.targetOrganizationId
        ) {
          return Response.json(
            { success: false, code: "provisional_convergence_conflict" },
            { status: 409 },
          );
        }
        return Response.json({
          success: true,
          alreadyAliased: true,
          history: [],
        });
      }
      const existing = await this.activeProvisionalConvergenceSeal();
      if (
        existing &&
        (existing.token !== payload.token ||
          existing.targetAgentId !== payload.targetAgentId ||
          existing.targetUserId !== payload.targetUserId ||
          existing.targetOrganizationId !== payload.targetOrganizationId)
      ) {
        return Response.json(
          { success: false, code: "provisional_convergence_in_progress" },
          { status: 423 },
        );
      }
      const seal: StoredProvisionalConvergenceSeal = {
        token: payload.token,
        holderIds: [
          ...new Set([...(existing?.holderIds ?? []), payload.holderId]),
        ],
        targetAgentId: payload.targetAgentId,
        targetUserId: payload.targetUserId,
        targetOrganizationId: payload.targetOrganizationId,
        expiresAt: Math.max(
          existing?.expiresAt ?? 0,
          Date.now() + payload.leaseMs,
        ),
      };
      await this.state.storage.put(PROVISIONAL_CONVERGENCE_SEAL_KEY, seal);
      const history = await this.runWithBindings(async () => {
        const { sharedRuntimeChatService } = await import(
          "@/lib/services/shared-runtime/shared-runtime-chat"
        );
        return await sharedRuntimeChatService.getHistory(
          payload.agentId,
          payload.agentId,
          historyStore,
        );
      });
      return Response.json({ success: true, alreadyAliased: false, history });
    }
    if (payload.operation === "provisional-convergence-import") {
      if (
        typeof payload.agentId !== "string" ||
        !payload.agentId.startsWith("personal:") ||
        typeof payload.token !== "string" ||
        payload.token.length === 0 ||
        typeof payload.holderId !== "string" ||
        payload.holderId.length === 0 ||
        !Array.isArray(payload.history)
      ) {
        return Response.json(
          { success: false, code: "invalid_provisional_convergence" },
          { status: 400 },
        );
      }
      const cutover = await this.activeCutoverSeal();
      if (cutover) {
        return Response.json(
          {
            success: false,
            code: cutover.committed
              ? "personal_eliza_dedicated"
              : "personal_cutover_in_progress",
          },
          { status: cutover.committed ? 409 : 423 },
        );
      }
      const reservation = await this.activeProvisionalConvergenceReservation();
      if (
        reservation?.token !== payload.token ||
        !reservation.holderIds.includes(payload.holderId)
      ) {
        return Response.json(
          { success: false, code: "provisional_convergence_not_reserved" },
          { status: 409 },
        );
      }
      const markerKey = `${PROVISIONAL_CONVERGENCE_IMPORT_PREFIX}${payload.token}`;
      if (await this.state.storage.get<boolean>(markerKey)) {
        return Response.json({ success: true, alreadyImported: true });
      }
      await historyStore.merge(
        payload.agentId,
        payload.agentId,
        payload.history,
      );
      await this.state.storage.put(markerKey, true);
      return Response.json({ success: true, alreadyImported: false });
    }
    if (payload.operation === "provisional-convergence-alias") {
      if (
        typeof payload.token !== "string" ||
        payload.token.length === 0 ||
        typeof payload.targetAgentId !== "string" ||
        !payload.targetAgentId.startsWith("personal:") ||
        typeof payload.targetUserId !== "string" ||
        payload.targetUserId.length === 0 ||
        typeof payload.targetOrganizationId !== "string" ||
        payload.targetOrganizationId.length === 0
      ) {
        return Response.json(
          { success: false, code: "invalid_provisional_convergence" },
          { status: 400 },
        );
      }
      const existingAlias =
        await this.state.storage.get<StoredProvisionalConvergenceAlias>(
          PROVISIONAL_CONVERGENCE_ALIAS_KEY,
        );
      if (
        existingAlias &&
        (existingAlias.token !== payload.token ||
          existingAlias.targetAgentId !== payload.targetAgentId ||
          existingAlias.targetUserId !== payload.targetUserId ||
          existingAlias.targetOrganizationId !== payload.targetOrganizationId)
      ) {
        return Response.json(
          { success: false, code: "provisional_convergence_conflict" },
          { status: 409 },
        );
      }
      if (existingAlias) {
        return Response.json({ success: true });
      }
      const activeSeal = await this.activeProvisionalConvergenceSeal();
      if (
        !activeSeal ||
        activeSeal.token !== payload.token ||
        activeSeal.targetAgentId !== payload.targetAgentId ||
        activeSeal.targetUserId !== payload.targetUserId ||
        activeSeal.targetOrganizationId !== payload.targetOrganizationId
      ) {
        return Response.json(
          { success: false, code: "provisional_convergence_not_prepared" },
          { status: 409 },
        );
      }
      await this.state.storage.put(PROVISIONAL_CONVERGENCE_ALIAS_KEY, {
        token: payload.token,
        targetAgentId: payload.targetAgentId,
        targetUserId: payload.targetUserId,
        targetOrganizationId: payload.targetOrganizationId,
      } satisfies StoredProvisionalConvergenceAlias);
      await this.state.storage.delete(PROVISIONAL_CONVERGENCE_SEAL_KEY);
      return Response.json({ success: true });
    }
    if (payload.operation === "provisional-convergence-release") {
      if (
        typeof payload.token !== "string" ||
        payload.token.length === 0 ||
        typeof payload.holderId !== "string" ||
        payload.holderId.length === 0
      ) {
        return Response.json(
          { success: false, code: "invalid_provisional_convergence" },
          { status: 400 },
        );
      }
      const activeSeal = await this.activeProvisionalConvergenceSeal();
      if (activeSeal?.token === payload.token) {
        const holderIds = activeSeal.holderIds.filter(
          (holderId) => holderId !== payload.holderId,
        );
        if (holderIds.length === 0) {
          await this.state.storage.delete(PROVISIONAL_CONVERGENCE_SEAL_KEY);
        } else {
          await this.state.storage.put(PROVISIONAL_CONVERGENCE_SEAL_KEY, {
            ...activeSeal,
            holderIds,
          } satisfies StoredProvisionalConvergenceSeal);
        }
      }
      const reservation = await this.activeProvisionalConvergenceReservation();
      if (reservation?.token === payload.token) {
        const holderIds = reservation.holderIds.filter(
          (holderId) => holderId !== payload.holderId,
        );
        if (holderIds.length === 0) {
          await this.state.storage.delete(
            PROVISIONAL_CONVERGENCE_RESERVATION_KEY,
          );
        } else {
          await this.state.storage.put(
            PROVISIONAL_CONVERGENCE_RESERVATION_KEY,
            {
              ...reservation,
              holderIds,
            } satisfies StoredProvisionalConvergenceReservation,
          );
        }
      }
      return Response.json({ success: true });
    }

    const convergenceAlias =
      await this.state.storage.get<StoredProvisionalConvergenceAlias>(
        PROVISIONAL_CONVERGENCE_ALIAS_KEY,
      );
    if (convergenceAlias && payload.operation !== "delete") {
      return await this.forwardToConvergedPersonalEliza(
        payload,
        convergenceAlias,
        request.signal,
      );
    }
    const convergenceSeal = await this.activeProvisionalConvergenceSeal();
    const convergenceReservation =
      await this.activeProvisionalConvergenceReservation();
    if (convergenceSeal || convergenceReservation) {
      return Response.json(
        {
          success: false,
          error: "Personal history is being linked. Retry shortly.",
          code: "personal_convergence_in_progress",
          retryable: true,
        },
        { status: 423, headers: { "Retry-After": "1" } },
      );
    }
    if (payload.operation === "prewarm") {
      await this.prewarmConversation(
        payload.agentId,
        payload.roomId,
        payload.startEmpty === true,
      );
      return Response.json({ success: true });
    }
    if (payload.operation === "cutover-seal") {
      const existing = await this.activeCutoverSeal();
      if (existing && existing.token !== payload.token) {
        return Response.json(
          {
            success: false,
            code: existing.committed
              ? "personal_eliza_dedicated"
              : "personal_cutover_in_progress",
          },
          { status: existing.committed ? 409 : 423 },
        );
      }
      const seal: StoredCutoverSeal = {
        token: payload.token,
        expiresAt: Date.now() + payload.leaseMs,
        committed: existing?.committed ?? false,
        organizationId: payload.organizationId,
        sourceAgentId: payload.agentId,
        dedicatedAgentId: payload.dedicatedAgentId,
      };
      await this.state.storage.put(CUTOVER_SEAL_KEY, seal);
      try {
        const history = await this.runWithBindings(async () => {
          const { sharedRuntimeChatService } = await import(
            "@/lib/services/shared-runtime/shared-runtime-chat"
          );
          return await sharedRuntimeChatService.getHistory(
            payload.agentId,
            payload.roomId,
            historyStore,
          );
        });
        return Response.json({ success: true, history });
      } catch (error) {
        const current = await this.activeCutoverSeal();
        if (current?.token === payload.token && !current.committed) {
          await this.state.storage.delete(CUTOVER_SEAL_KEY);
        }
        throw error;
      }
    }
    if (payload.operation === "cutover-release") {
      const existing = await this.activeCutoverSeal();
      if (existing?.token === payload.token && !existing.committed) {
        await this.state.storage.delete(CUTOVER_SEAL_KEY);
      }
      return Response.json({ success: true });
    }
    if (payload.operation === "cutover-commit") {
      const existing = await this.activeCutoverSeal();
      if (!existing || existing.token !== payload.token) {
        return Response.json(
          { success: false, code: "personal_cutover_seal_lost" },
          { status: 409 },
        );
      }
      await this.state.storage.put(CUTOVER_SEAL_KEY, {
        ...existing,
        committed: true,
      } satisfies StoredCutoverSeal);
      return Response.json({ success: true });
    }
    if (payload.operation === "history") {
      const history = await this.runWithBindings(async () => {
        const { sharedRuntimeChatService } = await import(
          "@/lib/services/shared-runtime/shared-runtime-chat"
        );
        return await sharedRuntimeChatService.getHistory(
          payload.agentId,
          payload.roomId,
          historyStore,
        );
      });
      return Response.json({ history });
    }

    // #17006: purge all DO-stored conversation state for this agent's room.
    // Dispatched from agent deletion (purgeSharedConversationRooms) after the
    // Postgres mirror rows are dropped; also cancels a pending mirror-retry
    // alarm so a queued retry cannot fire against the emptied room.
    if (payload.operation === "delete") {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
      this.conversation = null;
      return Response.json({ success: true });
    }

    const cutoverSeal = await this.activeCutoverSeal();
    if (cutoverSeal) {
      return Response.json(
        {
          success: false,
          error: cutoverSeal.committed
            ? "This personal Eliza is active on Dedicated."
            : "Dedicated cutover is finishing. Retry this turn shortly.",
          code: cutoverSeal.committed
            ? "personal_eliza_dedicated"
            : "personal_cutover_in_progress",
          retryable: !cutoverSeal.committed,
        },
        {
          status: cutoverSeal.committed ? 409 : 423,
          headers: cutoverSeal.committed ? {} : { "Retry-After": "1" },
        },
      );
    }

    return await this.runWithBindings(async () => {
      const { sharedRuntimeChatService } = await import(
        "@/lib/services/shared-runtime/shared-runtime-chat"
      );
      const agent = personal
        ? payload.agent
        : await import("@/lib/services/shared-runtime/cached-agent-dates").then(
            ({ rehydrateCachedAgentDates }) =>
              rehydrateCachedAgentDates(payload.agent),
          );
      const executionCtx = {
        waitUntil: (promise: Promise<unknown>) => this.state.waitUntil(promise),
      };
      if (
        payload.operation === "stream" ||
        payload.operation === "personal-stream"
      ) {
        return await sharedRuntimeChatService.stream(agent, payload.rpc, {
          abortSignal: request.signal,
          executionCtx,
          historyStore,
          turnClaims,
          funding: personal ? "platform" : "organization-credits",
        });
      }
      const result = await sharedRuntimeChatService.bridge(agent, payload.rpc, {
        executionCtx,
        historyStore,
        turnClaims,
        funding: personal ? "platform" : "organization-credits",
      });
      return Response.json(result);
    });
  }

  private releaseWhenConsumed(
    response: Response,
    release: () => void,
  ): Response {
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (next.done) {
            release();
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          // error-policy:J1 the response-stream boundary must release the
          // conversation lock before surfacing a read failure to the caller.
          release();
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const response = await this.handle(request);
      return this.releaseWhenConsumed(response, release);
    } catch (error) {
      // error-policy:J1 the Durable Object transport boundary translates cache
      // warming and credit insufficiency into structured responses (class
      // identity cannot survive the stub fetch boundary); every other failure
      // remains observable to Workers.
      release();
      if (error instanceof Error && error.name === "SharedTurnConflictError") {
        return Response.json(
          {
            success: false,
            error: error.message,
            code: "client_message_conflict",
            retryable: false,
          },
          { status: 409 },
        );
      }
      if (
        error instanceof ConversationCacheWarmingError ||
        (error instanceof Error &&
          error.name === "SharedRuntimeCacheWarmingError")
      ) {
        return Response.json(
          {
            success: false,
            error: error.message,
            code: "conversation_cache_warming",
            retryable: true,
          },
          { status: 503, headers: { "Retry-After": "1" } },
        );
      }
      const { InsufficientCreditsError, RateLimitError } = await import(
        "@/lib/api/errors"
      );
      if (error instanceof RateLimitError) {
        return Response.json(
          {
            success: false,
            error: error.message,
            code: "rate_limit_exceeded",
            retryable: true,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(error.retryAfter ?? 60),
            },
          },
        );
      }
      if (error instanceof InsufficientCreditsError) {
        return Response.json(
          {
            success: false,
            error: error.message,
            code: "insufficient_credits",
            retryable: false,
          },
          { status: 402 },
        );
      }
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const snapshot =
      this.conversation ??
      (await this.state.storage.get<StoredConversation>(CONVERSATION_KEY));
    if (snapshot?.dirty) {
      await this.scheduleMirror(snapshot);
    }
  }
}
