/**
 * Server-authoritative pendant session routes backed by runtime Memory records.
 *
 * The route owns capture leases, segment ordering, revision convergence, and
 * owner/agent isolation. It deliberately persists through AgentRuntime's Memory
 * API only: one deterministic custom-table memory stores each session document.
 */

import crypto from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  type JsonValue,
  logger,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  AcquirePendantLeaseRequestSchema,
  CreatePendantSessionRequestSchema,
  PatchPendantSegmentRequestSchema,
  PENDANT_SESSION_SYNC_SCHEMA_VERSION,
  PendantControlRequestSchema,
  type PendantInsightRef,
  PendantInsightRefSchema,
  PendantMutationResponseSchema,
  PendantProcessingLocationSchema,
  type PendantSegment,
  PendantSegmentSchema,
  type PendantSession,
  type PendantSessionErrorCode,
  type PendantSessionSnapshot,
  PendantSessionSnapshotSchema,
  PendantSessionStateSchema,
  pendantSegmentId,
  UpsertPendantInsightRefsRequestSchema,
  UpsertPendantSegmentRequestSchema,
} from "@elizaos/shared/contracts";
import z from "zod";
import type { ServerState } from "./server-types.ts";

const PREFIX = "/api/pendant/sessions";
const TABLE_NAME = "pendant_sessions";
const MEMORY_SOURCE = "pendant_session_sync";
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
  state: Pick<ServerState, "runtime" | "adminEntityId" | "broadcastWs">;
  readJsonBody: ReadJsonBody;
  json: JsonHelper;
}

interface StoredCaptureLease {
  holder: string;
  expiresAt: string;
  tokenDigest: string;
}

interface StoredPendantSessionDocument {
  schemaVersion: 1;
  session: Omit<PendantSession, "captureLease"> & {
    captureLease: StoredCaptureLease | null;
  };
  segments: PendantSegment[];
  insightRefs: PendantInsightRef[];
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
const StoredCaptureLeaseSchema = z
  .object({
    holder: z.string().min(1),
    expiresAt: z.string().datetime(),
    tokenDigest: z.string().min(1),
  })
  .strict();
const StoredPendantSessionDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    session: z
      .object({
        id: z.string().min(1),
        ownerId: z.string().min(1),
        agentId: z.string().min(1),
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime().nullable(),
        state: PendantSessionStateSchema,
        captureLease: StoredCaptureLeaseSchema.nullable(),
        processingLocation: PendantProcessingLocationSchema,
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    segments: z.array(PendantSegmentSchema),
    insightRefs: z.array(PendantInsightRefSchema),
  })
  .strict();

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

function sessionMemoryId(
  ownerId: string,
  agentId: string,
  sessionId: string,
): UUID {
  return stringToUuid(`pendant-session:${ownerId}:${agentId}:${sessionId}`);
}

function sessionRoomId(ownerId: string, agentId: string): UUID {
  return stringToUuid(`pendant-session-room:${ownerId}:${agentId}`);
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
  const agentId = String(runtime.agentId ?? "").trim();
  const ownerId = String(adminEntityId ?? "").trim();
  if (!agentId || !ownerId) {
    throw routeError(
      "auth",
      "Authenticated owner boundary is unavailable",
      401,
    );
  }
  return { runtime, ownerId, agentId };
}

function readStoredDocument(memory: Memory): StoredPendantSessionDocument {
  const payload = (memory.content as { pendantSession?: unknown })
    .pendantSession;
  const parsed = StoredPendantSessionDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    throw routeError(
      "store_unavailable",
      "Stored pendant session record is invalid",
      503,
    );
  }
  return parsed.data;
}

async function loadStored(params: {
  runtime: AgentRuntime;
  ownerId: string;
  agentId: string;
  sessionId: string;
}): Promise<StoredPendantSessionDocument> {
  const memory = await params.runtime.getMemoryById(
    sessionMemoryId(params.ownerId, params.agentId, params.sessionId),
  );
  if (!memory) {
    throw routeError("not_found", "Pendant session was not found", 404);
  }
  const stored = readStoredDocument(memory);
  if (
    stored.session.ownerId !== params.ownerId ||
    stored.session.agentId !== params.agentId
  ) {
    throw routeError("not_found", "Pendant session was not found", 404);
  }
  return stored;
}

async function persistStored(params: {
  runtime: AgentRuntime;
  ownerId: string;
  agentId: string;
  stored: StoredPendantSessionDocument;
  create?: boolean;
}): Promise<void> {
  const id = sessionMemoryId(
    params.ownerId,
    params.agentId,
    params.stored.session.id,
  );
  const memory: Memory = {
    id,
    entityId: params.ownerId as UUID,
    agentId: params.agentId as UUID,
    roomId: sessionRoomId(params.ownerId, params.agentId),
    content: {
      text: `Pendant session ${params.stored.session.id}`,
      pendantSession: params.stored as unknown as JsonValue,
    },
    metadata: {
      type: MemoryType.CUSTOM,
      source: MEMORY_SOURCE,
      sourceId: params.stored.session.id,
      scope: "owner-private",
      tags: ["pendant", "session"],
    },
    createdAt: Date.parse(params.stored.session.startedAt),
  };
  if (params.create) {
    try {
      await params.runtime.createMemory(memory, TABLE_NAME, true);
    } catch {
      throw routeError(
        "store_unavailable",
        "Pendant session store is unavailable",
        503,
      );
    }
    return;
  }
  const updated = await params.runtime.updateMemory({
    id,
    content: memory.content,
    metadata: memory.metadata,
  });
  if (!updated) {
    throw routeError(
      "store_unavailable",
      "Pendant session store is unavailable",
      503,
    );
  }
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
            const existing = await loadStored({ ...identity, sessionId });
            stored.session = existing.session;
            stored.segments = existing.segments;
            stored.insightRefs = existing.insightRefs;
            return;
          } catch (err) {
            if (
              !(err instanceof PendantSessionRouteError) ||
              err.code !== "not_found"
            ) {
              throw err;
            }
          }
          await persistStored({ ...identity, stored, create: true });
          created = true;
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
      const stored = await loadStored({ ...identity, sessionId });
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
      const stored = await loadStored({ ...identity, sessionId });
      json(res, { ok: true, export: snapshotFromStored(stored) });
      return true;
    }

    if (method === "DELETE" && tail.length === 0) {
      await withSessionLock(lockKey, async () => {
        await loadStored({ ...identity, sessionId });
        await identity.runtime.deleteMemory(
          sessionMemoryId(identity.ownerId, identity.agentId, sessionId),
        );
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
        const stored = await loadStored({ ...identity, sessionId });
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
        await persistStored({ ...identity, stored });
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
        const stored = await loadStored({ ...identity, sessionId });
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
          await persistStored({ ...identity, stored });
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
        await persistStored({ ...identity, stored });
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
        const stored = await loadStored({ ...identity, sessionId });
        assertCanAppend(stored);
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
        await persistStored({ ...identity, stored });
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
        const stored = await loadStored({ ...identity, sessionId });
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
        await persistStored({ ...identity, stored });
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
        const stored = await loadStored({ ...identity, sessionId });
        assertNotEnded(stored);
        assertControlRevision(stored, parsed.data.revision);
        stored.insightRefs = parsed.data.insightRefs;
        validateInsightRefs(stored);
        commit(stored);
        await persistStored({ ...identity, stored });
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
