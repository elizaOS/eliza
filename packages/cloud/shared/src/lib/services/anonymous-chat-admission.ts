/**
 * Cache-only anonymous chat identity and quota admission for Cloudflare Workers.
 *
 * One Durable Object per opaque session token serializes lifetime and hourly
 * counters. Cold objects hydrate from primary Postgres under `waitUntil`, and
 * admitted/refunded counter snapshots mirror back asynchronously by revision.
 * Short transport deadlines replay only endpoints with durable duplicate
 * semantics, so acknowledgement loss cannot hang or double-charge a request.
 */

import { createHash } from "node:crypto";
import {
  type AnonymousChatGateCounterSnapshot,
  anonymousSessionsRepository,
} from "../../db/repositories/anonymous-sessions";
import { retryOnTransientDbError } from "../../db/retry-transient";
import type {
  RuntimeDurableObjectNamespace,
  RuntimeDurableObjectStub,
} from "../../types/cloud-worker-env";
import { getCookieValueFromHeader } from "../http/cookie-header";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { contentModerationService } from "./content-moderation";

const ANONYMOUS_SESSION_COOKIE = "eliza-anon-session";
const DEFAULT_ANONYMOUS_HOURLY_LIMIT = 10;
const GATE_ATTEMPT_TIMEOUT_MS = 750;
const IDEMPOTENT_GATE_ATTEMPTS = 2;
const hydrationFlights = new Map<string, Promise<void>>();

export interface AnonymousChatGateContext {
  sessionId: string;
  userId: string;
  messageCount: number;
  messagesLimit: number;
}

export interface AnonymousChatGateCredential {
  readonly sessionToken: string;
  readonly context: AnonymousChatGateContext;
}

export interface AnonymousChatGateLease {
  readonly credential: AnonymousChatGateCredential;
  readonly requestId: string;
}

export interface AnonymousChatGateSnapshot {
  sessionId: string;
  revision: number;
  messageCount: number;
  hourlyMessageCount: number;
  hourlyResetAtMs: number | null;
  lastMessageAtMs: number;
}

export type AnonymousChatContextResolution =
  | {
      kind: "ready";
      credential: AnonymousChatGateCredential;
      blocked: boolean;
    }
  | { kind: "missing" }
  | { kind: "warming" }
  | { kind: "rejected" }
  | { kind: "unavailable" };

export type AnonymousChatLeaseResolution =
  | {
      kind: "admitted";
      lease: AnonymousChatGateLease;
      remaining: number;
      limit: number;
    }
  | {
      kind: "limited";
      reason: "message_limit";
      remaining: number;
      limit: number;
    }
  | {
      kind: "limited";
      reason: "hourly_limit";
      remaining: number;
      limit: number;
      retryAfter: number;
    }
  | { kind: "warming" }
  | { kind: "rejected" }
  | { kind: "unavailable" };

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

function gateNamespace(): RuntimeDurableObjectNamespace | undefined {
  return getCloudBinding<RuntimeDurableObjectNamespace>("ANONYMOUS_CHAT_GATES");
}

function gateName(sessionToken: string): string {
  const digest = createHash("sha256").update(sessionToken).digest("hex");
  return `anon-chat:${digest}`;
}

function gateStub(
  namespace: RuntimeDurableObjectNamespace,
  sessionToken: string,
): RuntimeDurableObjectStub {
  return namespace.getByName(gateName(sessionToken));
}

function hourlyLimit(): number {
  const parsed = Number.parseInt(getCloudAwareEnv().ANON_HOURLY_LIMIT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ANONYMOUS_HOURLY_LIMIT;
}

async function postGate(
  stub: RuntimeDurableObjectStub,
  path: string,
  body: Record<string, unknown>,
  attempts = 1,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(
          `Anonymous chat gate ${path} timed out after ${GATE_ATTEMPT_TIMEOUT_MS}ms`,
        );
        controller.abort(error);
        reject(error);
      }, GATE_ATTEMPT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        stub.fetch(`https://anonymous-chat-gate${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timedOut,
      ]);
    } catch (error) {
      // error-policy:J2 bounded retries preserve the original transport cause
      // and only replay operations whose object endpoints are idempotent.
      lastError = error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  throw new Error(`Anonymous chat gate ${path} failed after ${attempts} attempts`, {
    cause: lastError,
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    // error-policy:J3 a malformed object response is an explicit unavailable
    // result at this internal trust boundary, never an authorization.
    return {};
  }
}

function parseContext(value: unknown): AnonymousChatGateContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Record<string, unknown>;
  if (
    typeof context.sessionId !== "string" ||
    typeof context.userId !== "string" ||
    typeof context.messageCount !== "number" ||
    typeof context.messagesLimit !== "number"
  ) {
    return null;
  }
  return {
    sessionId: context.sessionId,
    userId: context.userId,
    messageCount: context.messageCount,
    messagesLimit: context.messagesLimit,
  };
}

function parseSnapshot(value: unknown): AnonymousChatGateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.sessionId !== "string" ||
    typeof snapshot.revision !== "number" ||
    typeof snapshot.messageCount !== "number" ||
    typeof snapshot.hourlyMessageCount !== "number" ||
    !(snapshot.hourlyResetAtMs === null || typeof snapshot.hourlyResetAtMs === "number") ||
    typeof snapshot.lastMessageAtMs !== "number"
  ) {
    return null;
  }
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    messageCount: snapshot.messageCount,
    hourlyMessageCount: snapshot.hourlyMessageCount,
    hourlyResetAtMs: snapshot.hourlyResetAtMs,
    lastMessageAtMs: snapshot.lastMessageAtMs,
  };
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveCanonicalInteger(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function hydrateGate(stub: RuntimeDurableObjectStub, sessionToken: string): Promise<void> {
  const authoritative = await anonymousSessionsRepository.getGateHydrationByToken(sessionToken);
  if (!authoritative) {
    await postGate(stub, "/invalidate", {});
    return;
  }

  const blocked = await contentModerationService.shouldBlockUser(authoritative.userId);
  const response = await postGate(stub, "/hydrate", {
    sessionId: authoritative.sessionId,
    userId: authoritative.userId,
    messageCount: authoritative.messageCount,
    messagesLimit: authoritative.messagesLimit,
    hourlyMessageCount: authoritative.hourlyMessageCount,
    hourlyResetAtMs: authoritative.hourlyResetAt?.getTime() ?? null,
    expiresAtMs: authoritative.expiresAt.getTime(),
    revision: authoritative.gateRevision,
    hourlyLimit: hourlyLimit(),
    blocked,
  });
  if (!response.ok) {
    throw new Error(`Anonymous chat gate hydration failed with status ${response.status}`);
  }
}

function scheduleHydration(
  stub: RuntimeDurableObjectStub,
  sessionToken: string,
  executionCtx: ExecutionContextLike,
): void {
  const name = gateName(sessionToken);
  let task = hydrationFlights.get(name);
  if (!task) {
    const current = hydrateGate(stub, sessionToken).finally(() => {
      if (hydrationFlights.get(name) === current) hydrationFlights.delete(name);
    });
    task = current;
    hydrationFlights.set(name, current);
  }
  executionCtx.waitUntil(
    task.catch((error) => {
      // error-policy:J7 hydration is diagnostic/background work; the cold
      // request already received a retryable warming response.
      logger.error("[AnonymousChatAdmission] hydration failed", {
        gate: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

function scheduleSnapshotPersistence(
  snapshot: AnonymousChatGateSnapshot,
  executionCtx: ExecutionContextLike,
): void {
  const dbSnapshot: AnonymousChatGateCounterSnapshot = {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    messageCount: snapshot.messageCount,
    hourlyMessageCount: snapshot.hourlyMessageCount,
    hourlyResetAt: snapshot.hourlyResetAtMs === null ? null : new Date(snapshot.hourlyResetAtMs),
    lastMessageAt: new Date(snapshot.lastMessageAtMs),
  };
  executionCtx.waitUntil(
    retryOnTransientDbError(
      () => anonymousSessionsRepository.persistGateCounterSnapshot(dbSnapshot),
      { attempts: 3 },
    ).catch((error) => {
      // error-policy:J7 the Durable Object remains authoritative; a later
      // higher-revision snapshot repairs a failed analytics mirror.
      logger.error("[AnonymousChatAdmission] counter mirror failed", {
        sessionId: snapshot.sessionId,
        revision: snapshot.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

export async function resolveAnonymousChatContext(
  request: Request,
  executionCtx: ExecutionContextLike,
): Promise<AnonymousChatContextResolution> {
  const sessionToken = getCookieValueFromHeader(
    request.headers.get("cookie"),
    ANONYMOUS_SESSION_COOKIE,
  );
  if (!sessionToken) return { kind: "missing" };

  const namespace = gateNamespace();
  if (!namespace) return { kind: "unavailable" };
  const stub = gateStub(namespace, sessionToken);

  let response: Response;
  try {
    response = await postGate(stub, "/context", {}, IDEMPOTENT_GATE_ATTEMPTS);
  } catch (error) {
    logger.error("[AnonymousChatAdmission] context read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "unavailable" };
  }
  const body = await responseBody(response);
  if (response.status === 503 && body.code === "anonymous_chat_gate_uninitialized") {
    scheduleHydration(stub, sessionToken, executionCtx);
    return { kind: "warming" };
  }
  if (response.status === 401 || response.status === 410) {
    return { kind: "rejected" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const context = parseContext(body.context);
  if (!context || typeof body.blocked !== "boolean") {
    return { kind: "unavailable" };
  }
  return {
    kind: "ready",
    credential: { sessionToken, context },
    blocked: body.blocked,
  };
}

export async function reserveAnonymousChatSlot(
  credential: AnonymousChatGateCredential,
  requestId: string,
  executionCtx: ExecutionContextLike,
): Promise<AnonymousChatLeaseResolution> {
  const namespace = gateNamespace();
  if (!namespace) return { kind: "unavailable" };
  const stub = gateStub(namespace, credential.sessionToken);

  let response: Response;
  try {
    response = await postGate(stub, "/lease", { requestId }, IDEMPOTENT_GATE_ATTEMPTS);
  } catch (error) {
    logger.error("[AnonymousChatAdmission] lease failed", {
      sessionId: credential.context.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "unavailable" };
  }
  const body = await responseBody(response);
  if (response.status === 503) return { kind: "warming" };
  if (response.status === 401 || response.status === 410) {
    return { kind: "rejected" };
  }
  if (response.status === 429) {
    const retryAfterHeader = positiveCanonicalInteger(response.headers.get("Retry-After"));
    if (
      body.reason === "message_limit" &&
      typeof body.remaining === "number" &&
      typeof body.limit === "number"
    ) {
      return {
        kind: "limited",
        reason: body.reason,
        remaining: body.remaining,
        limit: body.limit,
      };
    }
    if (
      body.reason === "hourly_limit" &&
      typeof body.remaining === "number" &&
      typeof body.limit === "number" &&
      positiveSafeInteger(body.retryAfter) &&
      retryAfterHeader !== null &&
      retryAfterHeader === body.retryAfter
    ) {
      return {
        kind: "limited",
        reason: body.reason,
        remaining: body.remaining,
        limit: body.limit,
        retryAfter: body.retryAfter,
      };
    }
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };

  const snapshot = parseSnapshot(body.snapshot);
  if (!snapshot || typeof body.remaining !== "number" || typeof body.limit !== "number") {
    return { kind: "unavailable" };
  }
  scheduleSnapshotPersistence(snapshot, executionCtx);
  return {
    kind: "admitted",
    lease: { credential, requestId },
    remaining: body.remaining,
    limit: body.limit,
  };
}

export async function refundAnonymousChatSlot(
  lease: AnonymousChatGateLease,
  executionCtx: ExecutionContextLike,
): Promise<void> {
  const namespace = gateNamespace();
  if (!namespace) {
    throw new Error("Anonymous chat gate binding is unavailable");
  }
  const response = await postGate(
    gateStub(namespace, lease.credential.sessionToken),
    "/refund",
    { requestId: lease.requestId },
    IDEMPOTENT_GATE_ATTEMPTS,
  );
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(`Anonymous chat gate refund failed with status ${response.status}`);
  }
  const snapshot = parseSnapshot(body.snapshot);
  if (snapshot) scheduleSnapshotPersistence(snapshot, executionCtx);
}

export async function markAnonymousChatSlotDispatched(
  lease: AnonymousChatGateLease,
): Promise<void> {
  const namespace = gateNamespace();
  if (!namespace) {
    throw new Error("Anonymous chat gate binding is unavailable");
  }
  const response = await postGate(
    gateStub(namespace, lease.credential.sessionToken),
    "/dispatch",
    { requestId: lease.requestId },
    IDEMPOTENT_GATE_ATTEMPTS,
  );
  if (!response.ok) {
    throw new Error(`Anonymous chat gate dispatch failed with status ${response.status}`);
  }
}

export async function commitAnonymousChatSlot(lease: AnonymousChatGateLease): Promise<void> {
  const namespace = gateNamespace();
  if (!namespace) {
    throw new Error("Anonymous chat gate binding is unavailable");
  }
  const response = await postGate(
    gateStub(namespace, lease.credential.sessionToken),
    "/commit",
    { requestId: lease.requestId },
    IDEMPOTENT_GATE_ATTEMPTS,
  );
  if (!response.ok) {
    throw new Error(`Anonymous chat gate commit failed with status ${response.status}`);
  }
}

export async function refreshAnonymousChatModeration(
  credential: AnonymousChatGateCredential,
): Promise<void> {
  const namespace = gateNamespace();
  if (!namespace) {
    throw new Error("Anonymous chat gate binding is unavailable");
  }
  const blocked = await contentModerationService.shouldBlockUser(credential.context.userId);
  const response = await postGate(gateStub(namespace, credential.sessionToken), "/moderation", {
    blocked,
  });
  if (!response.ok) {
    throw new Error(`Anonymous chat moderation refresh failed with status ${response.status}`);
  }
}

export async function invalidateAnonymousChatGateByToken(sessionToken: string): Promise<void> {
  const namespace = gateNamespace();
  if (!namespace) return;
  const response = await postGate(gateStub(namespace, sessionToken), "/invalidate", {});
  if (!response.ok) {
    throw new Error(`Anonymous chat gate invalidation failed with status ${response.status}`);
  }
}
