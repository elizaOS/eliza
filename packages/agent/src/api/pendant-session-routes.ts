/**
 * Server-authoritative pendant session routes backed by runtime database rows.
 *
 * The route owns capture leases, segment ordering, revision convergence, and
 * owner/agent isolation. Storage is normalized through pendant session tables:
 * one session row, ordered segment rows, and insight-reference rows.
 */

import crypto from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  readJsonBody as httpReadJsonBody,
  sendJson as httpSendJson,
  type LegacyRouteHandler,
  logger,
  type Route,
  resolveCanonicalOwnerId,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  AcquirePendantLeaseRequestSchema,
  CreatePendantSessionRequestSchema,
  PatchPendantSegmentRequestSchema,
  PENDANT_SESSION_SYNC_SCHEMA_VERSION,
  PendantControlRequestSchema,
  PendantMutationResponseSchema,
  type PendantSegment,
  type PendantSessionErrorCode,
  type PendantSessionSnapshot,
  PendantSessionSnapshotSchema,
  pendantSegmentId,
  UpsertPendantInsightRefsRequestSchema,
  UpsertPendantSegmentRequestSchema,
} from "@elizaos/shared/contracts/pendant-session-sync";
import z from "zod";
import { loadElizaConfig } from "../config/config.ts";
import {
  createPendantSessionRepository,
  type PendantSessionRepository,
  type StoredPendantSessionDocument,
} from "../services/pendant-session/repository.ts";
import { getViewsBroadcastWs } from "./views-routes.ts";

const PREFIX = "/api/pendant/sessions";
const MAX_SEGMENTS = 20_000;

type JsonHelper = (
  res: http.ServerResponse,
  data: unknown,
  status?: number,
) => void;

type ReadJsonBody = <T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<T | null>;

export interface PendantSessionRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
    broadcastWs?: (payload: object) => void;
    pendantSessionRepository?: PendantSessionRepository;
  };
  readJsonBody: ReadJsonBody;
  json: JsonHelper;
}

export interface PendantCommittedSegmentEvent {
  snapshot: PendantSessionSnapshot;
  segment: PendantSegment;
}

export type PendantCommittedSegmentHook = (
  event: PendantCommittedSegmentEvent,
) => void | Promise<void>;

const committedSegmentHooks = new Set<PendantCommittedSegmentHook>();
const sessionLocks = new Map<string, Promise<void>>();
export function subscribePendantCommittedSegments(
  hook: PendantCommittedSegmentHook,
): () => void {
  committedSegmentHooks.add(hook);
  return () => {
    committedSegmentHooks.delete(hook);
  };
}

function snapshotFromStored(
  stored: StoredPendantSessionDocument,
): PendantSessionSnapshot {
  const lease = stored.session.captureLease;
  return PendantSessionSnapshotSchema.parse({
    schemaVersion: PENDANT_SESSION_SYNC_SCHEMA_VERSION,
    session: {
      ...stored.session,
      captureLease: lease
        ? { holder: lease.holder, expiresAt: lease.expiresAt }
        : null,
    },
    segments: stored.segments,
    insightRefs: stored.insightRefs,
  });
}

class PendantSessionRouteError extends Error {
  constructor(
    readonly code: PendantSessionErrorCode,
    message: string,
    readonly status: number,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

function routeError(
  code: PendantSessionErrorCode,
  message: string,
  status: number,
  currentRevision?: number,
): PendantSessionRouteError {
  return new PendantSessionRouteError(code, message, status, currentRevision);
}

async function withSessionLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(
    () => next,
    () => next,
  );
  sessionLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sessionLocks.get(key) === current) {
      sessionLocks.delete(key);
    }
  }
}

function digestToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function newLeaseToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveIdentity(
  runtime: AgentRuntime | null,
  adminEntityId: UUID | null,
): { runtime: AgentRuntime; ownerId: string; agentId: string } {
  if (!runtime) {
    throw routeError(
      "store_unavailable",
      "Agent runtime is not available",
      503,
    );
  }
  const agentId = runtime.agentId == null ? "" : String(runtime.agentId).trim();
  const ownerId = adminEntityId == null ? "" : String(adminEntityId).trim();
  if (!agentId || !ownerId) {
    throw routeError(
      "auth",
      "Authenticated owner boundary is unavailable",
      401,
    );
  }
  return { runtime, ownerId, agentId };
}

async function loadStored(params: {
  repository: PendantSessionRepository;
  ownerId: string;
  agentId: string;
  sessionId: string;
}): Promise<StoredPendantSessionDocument> {
  const stored = await params.repository.load(params);
  if (!stored) {
    throw routeError("not_found", "Pendant session was not found", 404);
  }
  if (
    stored.session.ownerId !== params.ownerId ||
    stored.session.agentId !== params.agentId
  ) {
    throw routeError("not_found", "Pendant session was not found", 404);
  }
  return stored;
}

async function persistSession(
  repository: PendantSessionRepository,
  stored: StoredPendantSessionDocument,
): Promise<void> {
  await repository.saveSession(stored);
}

function assertNotEnded(stored: StoredPendantSessionDocument): void {
  if (stored.session.state === "ended") {
    throw routeError(
      "revision_conflict",
      "Ended pendant sessions are immutable",
      409,
      stored.session.revision,
    );
  }
}

function assertCanAppend(stored: StoredPendantSessionDocument): void {
  assertNotEnded(stored);
  if (stored.session.state === "paused") {
    throw routeError(
      "revision_conflict",
      "Paused pendant sessions do not accept capture segments",
      409,
      stored.session.revision,
    );
  }
}

function semanticEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertSameRevisionSegmentReplay(
  incoming: Omit<
    PendantSegment,
    "id" | "sessionId" | "createdAt" | "updatedAt"
  >,
  existing: PendantSegment,
  currentRevision: number,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (!semanticEqual(existing[key as keyof PendantSegment], value)) {
      throw routeError(
        "revision_conflict",
        "Pendant segment revision already exists with different content",
        409,
        currentRevision,
      );
    }
  }
}

function assertSameRevisionPatchReplay(
  patch: Partial<PendantSegment>,
  existing: PendantSegment,
  currentRevision: number,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "revision") continue;
    if (!semanticEqual(existing[key as keyof PendantSegment], value)) {
      throw routeError(
        "revision_conflict",
        "Pendant segment patch revision already exists with different content",
        409,
        currentRevision,
      );
    }
  }
}

function assertLease(
  stored: StoredPendantSessionDocument,
  leaseToken: string,
): void {
  const lease = stored.session.captureLease;
  if (!lease || Date.parse(lease.expiresAt) <= Date.now()) {
    throw routeError("lease_conflict", "Capture lease is not active", 409);
  }
  if (lease.tokenDigest !== digestToken(leaseToken)) {
    throw routeError(
      "lease_conflict",
      "Capture lease token does not match",
      409,
    );
  }
}

function assertControlRevision(
  stored: StoredPendantSessionDocument,
  revision: number | undefined,
): void {
  if (revision !== undefined && revision !== stored.session.revision) {
    throw routeError(
      "revision_conflict",
      "Pendant session revision does not match",
      409,
      stored.session.revision,
    );
  }
}

function commit(stored: StoredPendantSessionDocument): void {
  stored.session.revision += 1;
}

function validateInsightRefs(stored: StoredPendantSessionDocument): void {
  const segmentIds = new Set(stored.segments.map((segment) => segment.id));
  for (const ref of stored.insightRefs) {
    for (const segmentId of ref.segmentIds) {
      if (!segmentIds.has(segmentId)) {
        throw routeError(
          "validation",
          `Insight ref ${ref.id} references unknown segment ${segmentId}`,
          400,
        );
      }
    }
  }
}

async function notifyCommittedSegment(
  event: PendantCommittedSegmentEvent,
): Promise<void> {
  for (const hook of committedSegmentHooks) {
    try {
      await hook(event);
    } catch (err) {
      // error-policy:J7 post-commit consumers are observed here and must not falsify a durable mutation result.
      logger.warn(
        "[PendantSessionRoutes] Pendant segment hook failed",
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          sessionId: event.snapshot.session.id,
          segmentId: event.segment.id,
        }),
      );
    }
  }
}

function broadcastMutation(
  ctx: PendantSessionRouteContext,
  snapshot: PendantSessionSnapshot,
): void {
  // The existing websocket fan-out is process-wide, so publish only an
  // invalidation cursor. Authenticated clients fetch the owner-scoped snapshot.
  ctx.state.broadcastWs?.({
    type: "pendant-session:updated",
    sessionId: snapshot.session.id,
    agentId: snapshot.session.agentId,
    revision: snapshot.session.revision,
  });
}

function broadcastDelete(
  ctx: PendantSessionRouteContext,
  sessionId: string,
  agentId: string,
): void {
  ctx.state.broadcastWs?.({
    type: "pendant-session:deleted",
    sessionId,
    agentId,
  });
}

function sendTypedError(ctx: PendantSessionRouteContext, err: unknown): void {
  // error-policy:J1 route boundary translates pendant domain failures into typed wire errors.
  if (err instanceof PendantSessionRouteError) {
    ctx.json(
      ctx.res,
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.currentRevision !== undefined
            ? { currentRevision: err.currentRevision }
            : {}),
        },
      },
      err.status,
    );
    return;
  }
  logger.error(
    "[PendantSessionRoutes] Unhandled pendant session route error",
    JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
  );
  ctx.json(
    ctx.res,
    {
      ok: false,
      error: {
        code: "store_unavailable",
        message: "Pendant session store is unavailable",
      },
    },
    503,
  );
}

function parseSessionPath(pathname: string): {
  sessionId: string;
  tail: string[];
} | null {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  const parts = pathname.slice(PREFIX.length + 1).split("/");
  const sessionId = parts.shift();
  if (!sessionId) return null;
  try {
    return {
      sessionId: decodeURIComponent(sessionId),
      tail: parts.map((part) => decodeURIComponent(part)),
    };
  } catch {
    // error-policy:J3 malformed URL bytes are rejected as invalid input.
    throw routeError("validation", "Malformed URL encoding", 400);
  }
}

function parseAfterRevision(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw routeError(
      "validation",
      "afterRevision must be a nonnegative integer",
      400,
    );
  }
  return Number(raw);
}

export async function handlePendantSessionRoutes(
  ctx: PendantSessionRouteContext,
): Promise<boolean> {
  const { method, pathname, url, state, readJsonBody, json, res } = ctx;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;

  try {
    const identity = resolveIdentity(state.runtime, state.adminEntityId);
    const repository =
      state.pendantSessionRepository ??
      createPendantSessionRepository(identity.runtime);

    if (method === "POST" && pathname === PREFIX) {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = CreatePendantSessionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
      const startedAt = nowIso();
      const stored: StoredPendantSessionDocument = {
        schemaVersion: 1,
        session: {
          id: sessionId,
          ownerId: identity.ownerId,
          agentId: identity.agentId,
          startedAt,
          endedAt: null,
          state: "active",
          captureLease: null,
          processingLocation: parsed.data.processingLocation,
          revision: 0,
        },
        segments: [],
        insightRefs: [],
      };
      let created = false;
      await withSessionLock(
        `${identity.ownerId}:${identity.agentId}:${sessionId}`,
        async () => {
          try {
            const existing = await loadStored({
              repository,
              ...identity,
              sessionId,
            });
            stored.session = existing.session;
            stored.segments = existing.segments;
            stored.insightRefs = existing.insightRefs;
            return;
          } catch (err) {
            // error-policy:J1 create is idempotent; only the local not-found sentinel is consumed.
            if (
              !(err instanceof PendantSessionRouteError) ||
              err.code !== "not_found"
            ) {
              throw err;
            }
          }
          created = await repository.create(stored);
          if (!created) {
            // A different process may have won the atomic insert after our
            // initial read. Return its canonical row rather than our empty
            // candidate snapshot.
            const winner = await loadStored({
              repository,
              ...identity,
              sessionId,
            });
            stored.session = winner.session;
            stored.segments = winner.segments;
            stored.insightRefs = winner.insightRefs;
          }
        },
      );
      const snapshot = snapshotFromStored(stored);
      if (created) broadcastMutation(ctx, snapshot);
      json(res, { ok: true, snapshot });
      return true;
    }

    const parsedPath = parseSessionPath(pathname);
    if (!parsedPath) {
      throw routeError("not_found", "Pendant session route was not found", 404);
    }
    const { sessionId, tail } = parsedPath;
    const lockKey = `${identity.ownerId}:${identity.agentId}:${sessionId}`;

    if (method === "GET" && tail.length === 0) {
      const stored = await loadStored({ repository, ...identity, sessionId });
      const snapshot = snapshotFromStored(stored);
      const afterRevision = parseAfterRevision(
        url.searchParams.get("afterRevision"),
      );
      if (
        afterRevision !== undefined &&
        afterRevision >= snapshot.session.revision
      ) {
        json(res, { ok: true, changed: false });
        return true;
      }
      json(res, { ok: true, changed: true, snapshot });
      return true;
    }

    if (method === "GET" && tail.length === 1 && tail[0] === "export") {
      const stored = await loadStored({ repository, ...identity, sessionId });
      json(res, { ok: true, export: snapshotFromStored(stored) });
      return true;
    }

    if (method === "DELETE" && tail.length === 0) {
      await withSessionLock(lockKey, async () => {
        await loadStored({ repository, ...identity, sessionId });
        await repository.delete({
          ownerId: identity.ownerId,
          agentId: identity.agentId,
          sessionId,
        });
      });
      broadcastDelete(ctx, sessionId, identity.agentId);
      json(res, { ok: true, deleted: true });
      return true;
    }

    if (method === "POST" && tail.length === 1 && tail[0] === "lease") {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = AcquirePendantLeaseRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const result = await withSessionLock(lockKey, async () => {
        const stored = await loadStored({ repository, ...identity, sessionId });
        assertNotEnded(stored);
        const existing = stored.session.captureLease;
        const existingActive =
          existing !== null && Date.parse(existing.expiresAt) > Date.now();
        if (existingActive) {
          if (!parsed.data.leaseToken) {
            throw routeError(
              "lease_conflict",
              "Capture lease is already held",
              409,
              stored.session.revision,
            );
          }
          assertLease(stored, parsed.data.leaseToken);
          if (existing.holder !== parsed.data.holder) {
            throw routeError(
              "lease_conflict",
              "Active capture lease holder cannot be changed",
              409,
              stored.session.revision,
            );
          }
        }
        const leaseToken = newLeaseToken();
        stored.session.captureLease = {
          holder: parsed.data.holder,
          expiresAt: new Date(Date.now() + parsed.data.leaseMs).toISOString(),
          tokenDigest: digestToken(leaseToken),
        };
        commit(stored);
        await persistSession(repository, stored);
        return { snapshot: snapshotFromStored(stored), leaseToken };
      });
      broadcastMutation(ctx, result.snapshot);
      json(res, {
        ok: true,
        session: result.snapshot.session,
        leaseToken: result.leaseToken,
      });
      return true;
    }

    if (method === "POST" && tail.length === 1 && tail[0] === "segments") {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = UpsertPendantSegmentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const event = await withSessionLock(lockKey, async () => {
        const stored = await loadStored({ repository, ...identity, sessionId });
        assertCanAppend(stored);
        assertLease(stored, parsed.data.leaseToken);
        if (stored.segments.length >= MAX_SEGMENTS) {
          throw routeError(
            "validation",
            "Pendant session segment limit reached",
            400,
          );
        }
        const expectedId = pendantSegmentId(
          sessionId,
          parsed.data.segment.ordinal,
        );
        const existingIndex = stored.segments.findIndex(
          (segment) => segment.id === expectedId,
        );
        if (existingIndex >= 0) {
          const existing = stored.segments[existingIndex];
          const incoming: PendantSegment = {
            ...parsed.data.segment,
            id: existing.id,
            sessionId: existing.sessionId,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          };
          if (incoming.revision === existing.revision) {
            assertSameRevisionSegmentReplay(
              parsed.data.segment,
              existing,
              stored.session.revision,
            );
            return {
              snapshot: snapshotFromStored(stored),
              segment: existing,
              committed: false,
            };
          }
          if (incoming.revision !== existing.revision + 1) {
            throw routeError(
              "revision_conflict",
              "Pendant segment revision does not follow the current revision",
              409,
              stored.session.revision,
            );
          }
          const next: PendantSegment = {
            ...incoming,
            updatedAt: nowIso(),
          };
          stored.segments[existingIndex] = next;
          commit(stored);
          await repository.saveSegment(stored, next);
          return {
            snapshot: snapshotFromStored(stored),
            segment: next,
            committed: true,
          };
        }
        if (parsed.data.segment.ordinal !== stored.segments.length) {
          throw routeError(
            "validation",
            "Pendant segment ordinal is not contiguous",
            400,
          );
        }
        if (parsed.data.segment.revision !== 0) {
          throw routeError(
            "validation",
            "New pendant segments must start at revision 0",
            400,
          );
        }
        const createdAt = nowIso();
        const incoming: PendantSegment = {
          ...parsed.data.segment,
          id: expectedId,
          sessionId,
          createdAt,
          updatedAt: createdAt,
        };
        stored.segments.push(incoming);
        commit(stored);
        await repository.saveSegment(stored, incoming);
        return {
          snapshot: snapshotFromStored(stored),
          segment: incoming,
          committed: true,
        };
      });
      if (event.committed) {
        await notifyCommittedSegment(event);
        broadcastMutation(ctx, event.snapshot);
      }
      json(
        res,
        PendantMutationResponseSchema.parse({
          ok: true,
          snapshot: event.snapshot,
        }),
      );
      return true;
    }

    if (
      method === "PATCH" &&
      tail.length === 2 &&
      tail[0] === "segments" &&
      tail[1]
    ) {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = PatchPendantSegmentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const segmentId = tail[1];
      const event = await withSessionLock(lockKey, async () => {
        const stored = await loadStored({ repository, ...identity, sessionId });
        // Pausing prevents new capture segments, but already-durable pending
        // segments must still accept late ASR/diarization revisions.
        assertNotEnded(stored);
        assertLease(stored, parsed.data.leaseToken);
        const existingIndex = stored.segments.findIndex(
          (segment) => segment.id === segmentId,
        );
        if (existingIndex < 0) {
          throw routeError("not_found", "Pendant segment was not found", 404);
        }
        const existing = stored.segments[existingIndex];
        const { leaseToken: _leaseToken, ...patch } = parsed.data;
        if (parsed.data.revision === existing.revision) {
          assertSameRevisionPatchReplay(
            patch,
            existing,
            stored.session.revision,
          );
          return {
            snapshot: snapshotFromStored(stored),
            segment: existing,
            committed: false,
          };
        }
        if (parsed.data.revision !== existing.revision + 1) {
          throw routeError(
            "revision_conflict",
            "Pendant segment revision does not follow the current revision",
            409,
            stored.session.revision,
          );
        }
        const next: PendantSegment = {
          ...existing,
          ...patch,
          id: existing.id,
          sessionId: existing.sessionId,
          ordinal: existing.ordinal,
          createdAt: existing.createdAt,
          updatedAt: nowIso(),
          revision: parsed.data.revision,
        };
        stored.segments[existingIndex] = next;
        commit(stored);
        await repository.saveSegment(stored, next);
        return {
          snapshot: snapshotFromStored(stored),
          segment: next,
          committed: true,
        };
      });
      if (event.committed) {
        await notifyCommittedSegment(event);
        broadcastMutation(ctx, event.snapshot);
      }
      json(
        res,
        PendantMutationResponseSchema.parse({
          ok: true,
          snapshot: event.snapshot,
        }),
      );
      return true;
    }

    if (
      method === "POST" &&
      tail.length === 1 &&
      (tail[0] === "pause" || tail[0] === "resume" || tail[0] === "end")
    ) {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = PendantControlRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const result = await withSessionLock(lockKey, async () => {
        const stored = await loadStored({ repository, ...identity, sessionId });
        assertControlRevision(stored, parsed.data.revision);
        assertNotEnded(stored);
        const target =
          tail[0] === "pause"
            ? "paused"
            : tail[0] === "resume"
              ? "active"
              : "ended";
        if (stored.session.state === target) {
          return { snapshot: snapshotFromStored(stored), committed: false };
        }
        stored.session.state = target;
        if (target === "ended") {
          stored.session.endedAt = nowIso();
          stored.session.captureLease = null;
        }
        commit(stored);
        await persistSession(repository, stored);
        return { snapshot: snapshotFromStored(stored), committed: true };
      });
      if (result.committed) broadcastMutation(ctx, result.snapshot);
      json(res, { ok: true, snapshot: result.snapshot });
      return true;
    }

    if (method === "PUT" && tail.length === 1 && tail[0] === "insight-refs") {
      const raw = await readJsonBody(ctx.req, res);
      if (raw === null) return true;
      const parsed = UpsertPendantInsightRefsRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw routeError("validation", parsed.error.message, 400);
      }
      const snapshot = await withSessionLock(lockKey, async () => {
        const stored = await loadStored({ repository, ...identity, sessionId });
        assertNotEnded(stored);
        assertControlRevision(stored, parsed.data.revision);
        stored.insightRefs = parsed.data.insightRefs;
        validateInsightRefs(stored);
        commit(stored);
        await repository.replaceInsightRefs(stored);
        return snapshotFromStored(stored);
      });
      broadcastMutation(ctx, snapshot);
      json(res, { ok: true, snapshot });
      return true;
    }

    throw routeError("not_found", "Pendant session route was not found", 404);
  } catch (err) {
    sendTypedError(ctx, err);
    return true;
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const host =
    typeof req.headers.host === "string" && req.headers.host.trim()
      ? req.headers.host
      : "localhost";
  return `http://${host}`;
}

function requestUrl(req: http.IncomingMessage): URL {
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  const query = (
    req as http.IncomingMessage & {
      query?: Record<string, string | string[]>;
    }
  ).query;
  if (!query || url.search) return url;
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, item);
    }
  }
  return url;
}

async function readRouteJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  const augmented = req as http.IncomingMessage & { body?: unknown };
  if (Object.hasOwn(augmented, "body")) {
    return (augmented.body ?? null) as T | null;
  }
  return httpReadJsonBody<T>(req, res);
}

function routeOwnerEntityId(runtime: AgentRuntime | null): UUID | null {
  if (!runtime) return null;
  const ownerId = resolveCanonicalOwnerId(runtime);
  if (typeof ownerId === "string" && ownerId.trim()) return ownerId as UUID;

  // ServerState resolves the same persisted setting and deterministic fallback.
  // Recompute them here so runtime-plugin routing also works immediately after
  // first-run writes config, before the runtime itself has been restarted.
  const configured = loadElizaConfig().agents?.defaults?.adminEntityId?.trim();
  if (configured && z.string().uuid().safeParse(configured).success) {
    return configured as UUID;
  }
  const agentName = runtime.character?.name?.trim();
  return agentName ? stringToUuid(`${agentName}-admin-entity`) : null;
}

export function buildPendantSessionRouteContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): PendantSessionRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = requestUrl(req);
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: routeOwnerEntityId(runtime),
      broadcastWs: getViewsBroadcastWs() ?? undefined,
    },
    readJsonBody: readRouteJsonBody,
    json,
  };
}

const pendantSessionRouteHandler: LegacyRouteHandler = async (
  req,
  res,
  runtime,
) => {
  await handlePendantSessionRoutes(
    buildPendantSessionRouteContext(
      req as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      (runtime as AgentRuntime) ?? null,
    ),
  );
};

const PENDANT_SESSION_ROUTE_SPECS: ReadonlyArray<{
  type: Exclude<Route["type"], "STATIC">;
  path: string;
}> = [
  { type: "POST", path: "/api/pendant/sessions" },
  { type: "GET", path: "/api/pendant/sessions/:sessionId" },
  { type: "DELETE", path: "/api/pendant/sessions/:sessionId" },
  { type: "GET", path: "/api/pendant/sessions/:sessionId/export" },
  { type: "POST", path: "/api/pendant/sessions/:sessionId/lease" },
  { type: "POST", path: "/api/pendant/sessions/:sessionId/segments" },
  {
    type: "PATCH",
    path: "/api/pendant/sessions/:sessionId/segments/:segmentId",
  },
  { type: "POST", path: "/api/pendant/sessions/:sessionId/pause" },
  { type: "POST", path: "/api/pendant/sessions/:sessionId/resume" },
  { type: "POST", path: "/api/pendant/sessions/:sessionId/end" },
  { type: "PUT", path: "/api/pendant/sessions/:sessionId/insight-refs" },
];

export const pendantSessionRoutes: Route[] = PENDANT_SESSION_ROUTE_SPECS.map(
  (spec) => ({
    type: spec.type,
    path: spec.path,
    rawPath: true,
    handler: pendantSessionRouteHandler,
  }),
);
