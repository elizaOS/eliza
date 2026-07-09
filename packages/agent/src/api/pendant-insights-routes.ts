/**
 * Generates grounded pendant insight rollups through the active agent runtime.
 *
 * The route accepts only canonical session-sync segment identities, stamps
 * owner/agent/session provenance server-side, persists a private derived memory
 * in the same agent, and exposes cancellation and cascade-delete seams to the
 * server-authoritative session lane.
 */

import type http from "node:http";
import {
  logger,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  buildInsightsPrompt,
  composePendantInsights,
  type InsightSourceSegment,
  isEmptyInsights,
  MIN_INSIGHT_SEGMENTS,
  type PendantInsightSourceRef,
  type PendantInsights,
  type PendantInsightsSkipReason,
  PostPendantInsightsRequestSchema,
  parsePendantInsightsModelOutput,
} from "@elizaos/shared";

export type RunTextModel = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

export type GenerateInsightsResult =
  | {
      ok: true;
      insights: PendantInsights;
      sourceSegments: PendantInsightSourceRef[];
    }
  | { ok: false; skip: PendantInsightsSkipReason }
  | { ok: false; error: string };

/** Generate and validate one rollup without performing persistence. */
export async function generatePendantInsights(args: {
  segments: ReadonlyArray<InsightSourceSegment>;
  runModel: RunTextModel;
  priorSummary?: string;
  maxTranscriptChars?: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<GenerateInsightsResult> {
  const now = args.now ?? Date.now;
  const nonEmpty = args.segments.filter((segment) => segment.text.trim());
  if (nonEmpty.length < MIN_INSIGHT_SEGMENTS) {
    return { ok: false, skip: "too-few-segments" };
  }

  const built = buildInsightsPrompt({
    segments: nonEmpty,
    priorSummary: args.priorSummary,
    maxTranscriptChars: args.maxTranscriptChars,
  });
  if (built.includedSegmentIds.length === 0) {
    return { ok: false, skip: "empty-transcript" };
  }
  if (args.signal?.aborted) return { ok: false, skip: "cancelled" };

  let raw: string;
  try {
    raw = await args.runModel(built.prompt, args.signal);
  } catch (err) {
    // error-policy:J1 model boundary translates provider failure into an explicit generation failure.
    if (args.signal?.aborted) return { ok: false, skip: "cancelled" };
    return {
      ok: false,
      error: `model call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (args.signal?.aborted) return { ok: false, skip: "cancelled" };

  const parsed = parsePendantInsightsModelOutput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const includedById = new Map(
    nonEmpty.map((segment) => [segment.id, segment] as const),
  );
  const sourceSegments = built.includedSegmentIds.map((id) => {
    const source = includedById.get(id);
    if (!source) {
      throw new Error(
        `included insight segment ${id} was not in the source window`,
      );
    }
    return {
      id,
      ordinal: source.ordinal,
      revision: source.revision ?? 0,
    };
  });
  const insights = composePendantInsights({
    model: parsed.value,
    generatedAt: now(),
    transcriptRange: built.transcriptRange,
    knownSegmentIds: new Set(built.includedSegmentIds),
  });
  return { ok: true, insights, sourceSegments };
}

export interface PendantInsightsMemoryRuntime {
  agentId: UUID;
  getMemoryById(id: UUID): Promise<Memory | null>;
  createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ): Promise<UUID>;
  updateMemory(memory: Partial<Memory> & { id: UUID }): Promise<boolean>;
  deleteMemory(memoryId: UUID): Promise<void>;
  redactSecrets(text: string): string;
}

export interface PendantInsightsIdentity {
  ownerId: string;
  agentId: string;
  sessionId: string;
}

/** One deterministic derived-memory id per owner, agent, and pendant session. */
export function pendantInsightsMemoryId(
  identity: PendantInsightsIdentity,
): UUID {
  return stringToUuid(
    `pendant-insights:v1:${identity.ownerId}:${identity.agentId}:${identity.sessionId}`,
  );
}

function assertRuntimeIdentity(
  runtime: PendantInsightsMemoryRuntime,
  identity: PendantInsightsIdentity,
): void {
  if (String(runtime.agentId) !== identity.agentId) {
    throw new Error("pendant insight runtime agent identity mismatch");
  }
  if (!identity.ownerId || !identity.agentId || !identity.sessionId) {
    throw new Error("pendant insight provenance identity is incomplete");
  }
}

function assertMemoryIdentity(
  memory: Memory,
  identity: PendantInsightsIdentity,
): void {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  if (
    metadata?.source !== "pendant-insights" ||
    metadata.ownerId !== identity.ownerId ||
    metadata.agentId !== identity.agentId ||
    metadata.sessionId !== identity.sessionId
  ) {
    throw new Error(
      "refusing to mutate pendant insight memory outside its tenant session",
    );
  }
}

function buildPendantInsightsMemory(args: {
  runtime: PendantInsightsMemoryRuntime;
  identity: PendantInsightsIdentity;
  insights: PendantInsights;
  sourceSegments: readonly PendantInsightSourceRef[];
  generationStartedAt: number;
}): Memory {
  const id = pendantInsightsMemoryId(args.identity);
  return {
    id,
    agentId: args.runtime.agentId,
    // The agent self entity is guaranteed to exist at runtime initialization.
    // Owner isolation is enforced by the deterministic id + stamped metadata.
    entityId: args.runtime.agentId,
    // Agent initialization guarantees this self room exists; using a synthetic
    // room id would violate the SQL foreign key on a first insight write.
    roomId: args.runtime.agentId,
    worldId: args.runtime.agentId,
    createdAt: args.insights.generatedAt,
    unique: true,
    content: {
      // updateMemory bypasses AgentRuntime.createMemory's automatic redaction,
      // so redact explicitly before both create and update paths.
      text: args.runtime.redactSecrets(
        formatPendantInsightsMemory(args.insights),
      ),
      source: "pendant-insights",
    },
    metadata: {
      type: "custom",
      source: "pendant-insights",
      scope: "owner-private",
      timestamp: args.insights.generatedAt,
      tags: ["pendant", "insights", "ambient-memory"],
      schemaVersion: args.insights.schemaVersion,
      ownerId: args.identity.ownerId,
      agentId: args.identity.agentId,
      sessionId: args.identity.sessionId,
      sourceSegmentIds: args.sourceSegments.map((source) => source.id),
      sourceSegments: args.sourceSegments.map((source) => ({ ...source })),
      generationStartedAt: args.generationStartedAt,
    },
  };
}

function storedSourceSegments(memory: Memory): PendantInsightSourceRef[] {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  if (!Array.isArray(metadata?.sourceSegments)) return [];
  return metadata.sourceSegments.filter(
    (source): source is PendantInsightSourceRef =>
      typeof source === "object" &&
      source !== null &&
      typeof (source as { id?: unknown }).id === "string" &&
      Number.isInteger((source as { ordinal?: unknown }).ordinal) &&
      Number.isInteger((source as { revision?: unknown }).revision),
  );
}

/** True when an incoming generation is at least as fresh as stored provenance. */
function shouldReplaceStoredRollup(args: {
  existing: Memory;
  incomingSources: readonly PendantInsightSourceRef[];
  generationStartedAt: number;
}): boolean {
  const existingSources = storedSourceSegments(args.existing);
  if (existingSources.length === 0) return true;
  const incomingEnd = Math.max(
    ...args.incomingSources.map((source) => source.ordinal),
  );
  const existingEnd = Math.max(
    ...existingSources.map((source) => source.ordinal),
  );
  if (incomingEnd !== existingEnd) return incomingEnd > existingEnd;

  const existingRevisions = new Map(
    existingSources.map((source) => [source.id, source.revision] as const),
  );
  let hasNewerRevision = false;
  let hasOlderRevision = false;
  for (const source of args.incomingSources) {
    const existingRevision = existingRevisions.get(source.id);
    if (existingRevision === undefined) continue;
    if (source.revision > existingRevision) hasNewerRevision = true;
    if (source.revision < existingRevision) hasOlderRevision = true;
  }
  if (hasNewerRevision !== hasOlderRevision) return hasNewerRevision;

  const metadata = args.existing.metadata as
    | Record<string, unknown>
    | undefined;
  const existingStartedAt = metadata?.generationStartedAt;
  return (
    typeof existingStartedAt !== "number" ||
    args.generationStartedAt > existingStartedAt
  );
}

const persistenceLocks = new Map<string, Promise<void>>();

async function withPersistenceLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = persistenceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(
    () => next,
    () => next,
  );
  persistenceLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (persistenceLocks.get(key) === current) persistenceLocks.delete(key);
  }
}

/**
 * Persist the latest substantive rollup for one tenant-scoped session. Replays
 * and late segment revisions update the same derived memory instead of creating
 * duplicate notes or leaving stale text-hash identities behind.
 */
export async function persistPendantInsights(args: {
  runtime: PendantInsightsMemoryRuntime;
  identity: PendantInsightsIdentity;
  insights: PendantInsights;
  sourceSegments: readonly PendantInsightSourceRef[];
  /** Captured when the request starts, not when a slower model call completes. */
  generationStartedAt?: number;
  signal?: AbortSignal;
}): Promise<UUID | null> {
  if (isEmptyInsights(args.insights) || args.signal?.aborted) return null;
  assertRuntimeIdentity(args.runtime, args.identity);
  if (args.sourceSegments.length === 0) {
    throw new Error("pendant insight persistence requires source provenance");
  }

  const id = pendantInsightsMemoryId(args.identity);
  const generationStartedAt = args.generationStartedAt ?? Date.now();
  return withPersistenceLock(String(id), async () => {
    if (args.signal?.aborted) return null;
    const memory = buildPendantInsightsMemory({ ...args, generationStartedAt });
    const existing = await args.runtime.getMemoryById(id);
    if (args.signal?.aborted) return null;
    if (existing) {
      assertMemoryIdentity(existing, args.identity);
      if (
        !shouldReplaceStoredRollup({
          existing,
          incomingSources: args.sourceSegments,
          generationStartedAt,
        })
      ) {
        return id;
      }
      await args.runtime.updateMemory({
        id,
        content: memory.content,
        metadata: memory.metadata,
        createdAt: memory.createdAt,
      });
      return id;
    }
    await args.runtime.createMemory(memory, "messages", true);
    return id;
  });
}

const activeGenerations = new Map<string, Set<AbortController>>();
let lastGenerationStartedAt = 0;

function nextGenerationStartedAt(): number {
  lastGenerationStartedAt = Math.max(Date.now(), lastGenerationStartedAt + 1);
  return lastGenerationStartedAt;
}

function generationKey(identity: PendantInsightsIdentity): string {
  return `${identity.ownerId}\u0000${identity.agentId}\u0000${identity.sessionId}`;
}

function registerGeneration(
  identity: PendantInsightsIdentity,
  controller: AbortController,
): () => void {
  const key = generationKey(identity);
  const controllers = activeGenerations.get(key) ?? new Set<AbortController>();
  controllers.add(controller);
  activeGenerations.set(key, controllers);
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) activeGenerations.delete(key);
  };
}

/** Abort every in-flight model request for one exact tenant session. */
export function cancelPendantInsightGenerationForSession(
  identity: PendantInsightsIdentity,
): number {
  const controllers = activeGenerations.get(generationKey(identity));
  if (!controllers) return 0;
  let cancelled = 0;
  for (const controller of controllers) {
    if (!controller.signal.aborted) {
      controller.abort("session-deleted");
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Session-sync cascade seam. Cancellation happens before deletion, and the
 * deterministic memory is deleted only after its owner/agent/session provenance
 * is re-validated. A mismatched tenant fails closed.
 */
export async function cascadeDeletePendantInsightsForSession(args: {
  runtime: PendantInsightsMemoryRuntime;
  identity: PendantInsightsIdentity;
}): Promise<{ cancelled: number; deleted: boolean }> {
  assertRuntimeIdentity(args.runtime, args.identity);
  const cancelled = cancelPendantInsightGenerationForSession(args.identity);
  const id = pendantInsightsMemoryId(args.identity);
  const deleted = await withPersistenceLock(String(id), async () => {
    const existing = await args.runtime.getMemoryById(id);
    if (!existing) return false;
    assertMemoryIdentity(existing, args.identity);
    await args.runtime.deleteMemory(id);
    return true;
  });
  return { cancelled, deleted };
}

/** Searchable rendering for the agent's existing memory/retrieval path. */
export function formatPendantInsightsMemory(insights: PendantInsights): string {
  const lines = ["Pendant conversation insights"];
  if (insights.summary) lines.push(`Summary: ${insights.summary}`);
  if (insights.actionItems.length > 0) {
    lines.push("Action items:");
    for (const item of insights.actionItems) {
      const details = [
        item.owner ? `owner: ${item.owner}` : "",
        item.dueAt ? `due: ${item.dueAt}` : "",
        `confidence: ${item.confidence}`,
      ].filter(Boolean);
      lines.push(`- ${item.text} (${details.join(", ")})`);
    }
  }
  if (insights.topics.length > 0) {
    lines.push(
      `Topics: ${insights.topics.map((topic) => topic.label).join(", ")}`,
    );
  }
  if (insights.peopleMentioned.length > 0) {
    lines.push(
      `People mentioned: ${insights.peopleMentioned.map((person) => person.name).join(", ")}`,
    );
  }
  if (insights.notableQuotes.length > 0) {
    lines.push("Notable quotes:");
    for (const quote of insights.notableQuotes) {
      lines.push(
        `- ${quote.speaker ? `${quote.speaker}: ` : ""}"${quote.text}"`,
      );
    }
  }
  return lines.join("\n");
}

export interface PendantInsightsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: {
    runtime:
      | (PendantInsightsMemoryRuntime & { useModel: RunTextModel | unknown })
      | null;
    adminEntityId: UUID | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
}

/** Handle `POST /api/pendant/insights`. */
export async function handlePendantInsightsRoutes(
  ctx: PendantInsightsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;
  if (!(method === "POST" && pathname === "/api/pendant/insights")) {
    return false;
  }

  const raw = await readJsonBody<Record<string, unknown>>(req, res, {
    maxBytes: 5 * 1024 * 1024,
  });
  if (raw === null) return true;
  const parsed = PostPendantInsightsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    error(res, parsed.error.issues[0]?.message ?? "Invalid request body", 400);
    return true;
  }

  const runtime = state.runtime;
  if (
    !runtime ||
    typeof (runtime as { useModel?: unknown }).useModel !== "function"
  ) {
    json(res, { ok: false, reason: "runtime-unavailable" });
    return true;
  }
  const ownerId = String(state.adminEntityId ?? "").trim();
  const agentId = String(runtime.agentId ?? "").trim();
  if (!ownerId || !agentId) {
    error(res, "Authenticated owner boundary is unavailable", 401);
    return true;
  }
  const identity: PendantInsightsIdentity = {
    ownerId,
    agentId,
    sessionId: parsed.data.sessionId,
  };
  const generationStartedAt = nextGenerationStartedAt();

  const controller = new AbortController();
  const unregisterGeneration = registerGeneration(identity, controller);
  const abortForDisconnect = (): void => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort("client-disconnected");
    }
  };
  req.once("aborted", abortForDisconnect);
  res.once("close", abortForDisconnect);
  if (req.aborted || res.destroyed) abortForDisconnect();

  try {
    const modelRuntime = runtime as {
      useModel: (
        modelType: unknown,
        params: { prompt: string; signal?: AbortSignal },
      ) => Promise<unknown>;
    };
    const runModel: RunTextModel = async (prompt, signal) => {
      const out = await modelRuntime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        ...(signal ? { signal } : {}),
      });
      return typeof out === "string" ? out : String(out);
    };

    const result = await generatePendantInsights({
      segments: parsed.data.segments,
      runModel,
      priorSummary: parsed.data.priorSummary,
      maxTranscriptChars: parsed.data.maxTranscriptChars,
      signal: controller.signal,
    });
    if (res.destroyed) return true;
    if (!result.ok) {
      if ("skip" in result) {
        json(res, { ok: false, reason: result.skip });
      } else {
        error(res, result.error, 502);
      }
      return true;
    }

    let memoryId: UUID | null;
    try {
      memoryId = await persistPendantInsights({
        runtime,
        identity,
        insights: result.insights,
        sourceSegments: result.sourceSegments,
        generationStartedAt,
        signal: controller.signal,
      });
    } catch (err) {
      // error-policy:J1 route boundary reports persistence failure without exposing store internals.
      logger.error(
        "[PendantInsightsRoutes] Failed to persist derived insight memory",
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          agentId,
          sessionId: identity.sessionId,
        }),
      );
      error(res, "failed to persist pendant insights", 500);
      return true;
    }
    if (res.destroyed) return true;
    if (controller.signal.aborted) {
      json(res, { ok: false, reason: "cancelled" });
      return true;
    }

    json(res, {
      ok: true,
      insights: result.insights,
      provenance: {
        sessionId: identity.sessionId,
        agentId,
        memoryId: memoryId ? String(memoryId) : null,
        sourceSegments: result.sourceSegments,
      },
    });
    return true;
  } finally {
    unregisterGeneration();
    req.off("aborted", abortForDisconnect);
    res.off("close", abortForDisconnect);
  }
}
