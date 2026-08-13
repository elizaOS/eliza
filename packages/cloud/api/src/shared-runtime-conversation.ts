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
  | { operation: "history"; agentId: string; roomId: string }
  | { operation: "delete"; agentId: string };

interface StoredConversation {
  agentId: string;
  channelId: string;
  history: SharedTurnMessage[];
  dirty: boolean;
  version: number;
}

const CONVERSATION_KEY = "conversation";
const RETRY_DELAY_MS = 30_000;

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
  ): Promise<StoredConversation> {
    if (this.conversation) return this.conversation;
    if (this.conversation === undefined) {
      this.conversation =
        (await this.state.storage.get<StoredConversation>(CONVERSATION_KEY)) ??
        null;
    }
    if (this.conversation) return this.conversation;

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

  private historyStore(): SharedRuntimeHistoryStore {
    return {
      load: async (agentId, channelId) =>
        (await this.loadConversation(agentId, channelId)).history,
      merge: async (agentId, channelId, messages) => {
        const current = await this.loadConversation(agentId, channelId);
        const snapshot: StoredConversation = {
          agentId,
          channelId,
          history: boundSnapshotHistory(
            mergeSharedRuntimeHistoryMessages(
              current.history,
              messages,
              MAX_HISTORY_MESSAGES,
            ),
          ),
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

  private async handle(request: Request): Promise<Response> {
    const payload = (await request.json()) as ConversationRequest;
    const historyStore = this.historyStore();
    const turnClaims = this.turnClaims();
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

    return await this.runWithBindings(async () => {
      const { sharedRuntimeChatService } = await import(
        "@/lib/services/shared-runtime/shared-runtime-chat"
      );
      const agent =
        payload.operation === "personal-bridge"
          ? payload.agent
          : await import(
              "@/lib/services/shared-runtime/cached-agent-dates"
            ).then(({ rehydrateCachedAgentDates }) =>
              rehydrateCachedAgentDates(payload.agent),
            );
      const executionCtx = {
        waitUntil: (promise: Promise<unknown>) => this.state.waitUntil(promise),
      };
      if (payload.operation === "stream") {
        return await sharedRuntimeChatService.stream(agent, payload.rpc, {
          abortSignal: request.signal,
          executionCtx,
          historyStore,
          turnClaims,
        });
      }
      const result = await sharedRuntimeChatService.bridge(agent, payload.rpc, {
        executionCtx,
        historyStore,
        turnClaims,
        funding:
          payload.operation === "personal-bridge"
            ? "platform"
            : "organization-credits",
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
