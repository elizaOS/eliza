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
  AMBIENT_INSIGHT_DEFAULT_DAILY_CALL_CAP,
  AMBIENT_INSIGHT_DEFAULT_MIN_INTERVAL_MS,
  AMBIENT_INSIGHT_DEFAULT_MIN_SEGMENTS,
  buildInsightsPrompt,
  composePendantInsights,
  type InsightSourceSegment,
  isEmptyInsights,
  MIN_INSIGHT_SEGMENTS,
  mergePendantInsights,
  PENDANT_INSIGHTS_SCHEMA_VERSION,
  type PendantInsightSourceRef,
  type PendantInsights,
  type PendantInsightsKind,
  type PendantInsightsMode,
  type PendantInsightsSkipReason,
  PostPendantInsightsRequestSchema,
  parsePendantInsights,
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
  minSegments?: number;
  kind?: PendantInsightsKind;
  dayKey?: string;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<GenerateInsightsResult> {
  const now = args.now ?? Date.now;
  const nonEmpty = args.segments.filter((segment) => segment.text.trim());
  if (args.kind === "digest" && nonEmpty.length === 0) {
    return {
      ok: true,
      insights: {
        schemaVersion: PENDANT_INSIGHTS_SCHEMA_VERSION,
        summary: "",
        summarySourceSegmentIds: [],
        actionItems: [],
        topics: [],
        peopleMentioned: [],
        notableQuotes: [],
        kind: "digest",
        ...(args.dayKey ? { dayKey: args.dayKey } : {}),
        digest: {
          summary: "",
          summarySourceSegmentIds: [],
          actionItems: [],
          commitments: [],
          followUps: [],
          notableMoments: [],
        },
        generatedAt: now(),
        transcriptRange: {
          startOrdinal: 0,
          endOrdinal: 0,
          segmentCount: 0,
          startedAtMs: 0,
          endedAtMs: 0,
        },
      },
      sourceSegments: [],
    };
  }
  if (nonEmpty.length < (args.minSegments ?? MIN_INSIGHT_SEGMENTS)) {
    return { ok: false, skip: "too-few-segments" };
  }

  const built = buildInsightsPrompt({
    segments: nonEmpty,
    priorSummary: args.priorSummary,
    maxTranscriptChars: args.maxTranscriptChars,
    kind: args.kind,
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
  let insights: PendantInsights;
  try {
    insights = composePendantInsights({
      model: parsed.value,
      generatedAt: now(),
      transcriptRange: built.transcriptRange,
      knownSegmentIds: new Set(built.includedSegmentIds),
      kind: args.kind,
      dayKey: args.dayKey,
    });
  } catch (err) {
    return {
      ok: false,
      error: `model output failed insight validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true, insights, sourceSegments };
}

const AMBIENT_DIGEST_MAX_CHUNK_SEGMENTS = 200;
const AMBIENT_DIGEST_DEFAULT_CHUNK_CHARS = 12_000;

function chunkAmbientDigestSegments(
  segments: ReadonlyArray<InsightSourceSegment>,
  maxTranscriptChars = AMBIENT_DIGEST_DEFAULT_CHUNK_CHARS,
): InsightSourceSegment[][] {
  const chunks: InsightSourceSegment[][] = [];
  let chunk: InsightSourceSegment[] = [];
  let chars = 0;
  for (const segment of segments) {
    const estimatedChars = segment.text.trim().length + segment.id.length + 16;
    if (
      chunk.length > 0 &&
      (chunk.length >= AMBIENT_DIGEST_MAX_CHUNK_SEGMENTS ||
        chars + estimatedChars > maxTranscriptChars)
    ) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(segment);
    chars += estimatedChars;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Generate one persisted digest from bounded model windows. Each chunk is one
 * budgeted model call, then deterministic merging combines grounded citations.
 */
export async function generateAmbientDigest(args: {
  segments: ReadonlyArray<InsightSourceSegment>;
  runModel: RunTextModel;
  priorSummary?: string;
  maxTranscriptChars?: number;
  dayKey: string;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<GenerateInsightsResult> {
  const chunks = chunkAmbientDigestSegments(
    args.segments.filter((segment) => segment.text.trim()),
    args.maxTranscriptChars,
  );
  if (chunks.length === 0) {
    return generatePendantInsights({
      ...args,
      segments: [],
      kind: "digest",
      minSegments: 0,
    });
  }
  let merged: GenerateInsightsResult | undefined;
  for (const chunk of chunks) {
    const result = await generatePendantInsights({
      ...args,
      segments: chunk,
      kind: "digest",
      minSegments: 0,
    });
    if (!result.ok) return result;
    if (!merged?.ok) {
      merged = result;
      continue;
    }
    const sources = new Map(
      merged.sourceSegments.map((source) => [source.id, source] as const),
    );
    for (const source of result.sourceSegments) sources.set(source.id, source);
    merged = {
      ok: true,
      insights: mergePendantInsights(merged.insights, result.insights),
      sourceSegments: Array.from(sources.values()).sort(
        (a, b) => a.ordinal - b.ordinal,
      ),
    };
  }
  return merged ?? { ok: false, skip: "empty-transcript" };
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
  /** Trusted agent configuration, used for the owner-local digest day. */
  getSetting?(key: string): unknown;
}

export interface PendantInsightsIdentity {
  ownerId: string;
  agentId: string;
  sessionId: string;
  kind?: PendantInsightsKind;
  dayKey?: string;
}

/** One deterministic derived-memory id per owner, agent, session, and record kind. */
export function pendantInsightsMemoryId(
  identity: PendantInsightsIdentity,
): UUID {
  const kind = identity.kind ?? "rollup";
  if (kind === "digest") {
    if (!identity.dayKey)
      throw new Error("digest insight memory requires dayKey");
    return stringToUuid(
      `pendant-insights:v1:${identity.ownerId}:${identity.agentId}:${identity.sessionId}:digest:${identity.dayKey}`,
    );
  }
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
    metadata.sessionId !== identity.sessionId ||
    ((identity.kind ?? "rollup") === "digest" &&
      metadata.dayKey !== identity.dayKey)
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
      kind: args.insights.kind,
      ...(args.insights.dayKey ? { dayKey: args.insights.dayKey } : {}),
      ownerId: args.identity.ownerId,
      agentId: args.identity.agentId,
      sessionId: args.identity.sessionId,
      insights: args.insights,
      sourceSegmentIds: args.sourceSegments.map((source) => source.id),
      sourceSegments: args.sourceSegments.map((source) => ({ ...source })),
      generationStartedAt: args.generationStartedAt,
      ambient: {
        dayKey: args.insights.dayKey,
        dailyCallCount: args.insights.dayKey
          ? (ambientDailyCalls.get(
              budgetKey(args.identity, args.insights.dayKey),
            ) ?? 0)
          : undefined,
        lastSuccessfulRollupEndOrdinal:
          args.insights.kind === "rollup" && args.sourceSegments.length > 0
            ? Math.max(...args.sourceSegments.map((source) => source.ordinal))
            : undefined,
        lastSuccessfulRollupAt:
          args.insights.kind === "rollup"
            ? args.insights.generatedAt
            : undefined,
      },
    },
  };
}

function storedSourceSegments(
  memory: Memory | null,
): PendantInsightSourceRef[] {
  const metadata = memory?.metadata as Record<string, unknown> | undefined;
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
  /** Ambient rollups persist empty checkpoints so quiet windows are not replayed. */
  persistEmpty?: boolean;
  signal?: AbortSignal;
}): Promise<UUID | null> {
  if (
    (isEmptyInsights(args.insights) &&
      args.insights.kind !== "digest" &&
      !args.persistEmpty) ||
    args.signal?.aborted
  ) {
    return null;
  }
  assertRuntimeIdentity(args.runtime, args.identity);
  if (args.sourceSegments.length === 0 && args.insights.kind !== "digest") {
    throw new Error("pendant insight persistence requires source provenance");
  }

  const id = pendantInsightsMemoryId(args.identity);
  const generationStartedAt = args.generationStartedAt ?? Date.now();
  return withPersistenceLock(String(id), async () => {
    if (args.signal?.aborted) return null;
    let sourceSegments = args.sourceSegments;
    const memory = buildPendantInsightsMemory({ ...args, generationStartedAt });
    const existing = await args.runtime.getMemoryById(id);
    if (args.signal?.aborted) return null;
    if (existing) {
      assertMemoryIdentity(existing, args.identity);
      if (args.insights.kind === "digest") return id;
      if (args.insights.kind === "rollup") {
        const sourcesById = new Map<string, PendantInsightSourceRef>();
        for (const source of storedSourceSegments(existing)) {
          sourcesById.set(source.id, source);
        }
        for (const source of args.sourceSegments) {
          const previous = sourcesById.get(source.id);
          sourcesById.set(source.id, {
            ...source,
            revision: Math.max(previous?.revision ?? 0, source.revision),
          });
        }
        sourceSegments = Array.from(sourcesById.values()).sort(
          (a, b) => a.ordinal - b.ordinal,
        );
        const metadata = existing.metadata as
          | Record<string, unknown>
          | undefined;
        const parsedExisting = parsePendantInsights(metadata?.insights);
        if (parsedExisting.ok) {
          const merged = mergePendantInsights(
            parsedExisting.value,
            args.insights,
          );
          const mergedInsights = {
            ...merged,
            transcriptRange: {
              ...merged.transcriptRange,
              segmentCount: sourceSegments.length,
            },
          } satisfies PendantInsights;
          const mergedMemory = buildPendantInsightsMemory({
            ...args,
            insights: mergedInsights,
            sourceSegments,
            generationStartedAt,
          });
          memory.content = mergedMemory.content;
          memory.metadata = mergedMemory.metadata;
        } else {
          const rebuiltMemory = buildPendantInsightsMemory({
            ...args,
            sourceSegments,
            generationStartedAt,
          });
          memory.content = rebuiltMemory.content;
          memory.metadata = rebuiltMemory.metadata;
        }
      }
      if (
        !shouldReplaceStoredRollup({
          existing,
          incomingSources: sourceSegments,
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
/**
 * Ambient cost is enforced in the route before `runtime.useModel`, not only by a
 * client scheduler. These maps are intentionally process-local: they make
 * concurrent requests in this agent process honest, while persisted rollup and
 * digest memories carry the lifecycle markers needed after a restart.
 */
const ambientBudgetLocks = new Map<string, Promise<void>>();
const ambientDailyCalls = new Map<string, number>();
const ambientLastRollupAt = new Map<string, number>();
const ambientDigests = new Set<string>();

function nextGenerationStartedAt(): number {
  lastGenerationStartedAt = Math.max(Date.now(), lastGenerationStartedAt + 1);
  return lastGenerationStartedAt;
}

function generationKey(identity: PendantInsightsIdentity): string {
  return `${identity.ownerId}\u0000${identity.agentId}\u0000${identity.sessionId}`;
}

function localDayKey(atMs: number, timeZone: string): string {
  try {
    // en-CA is specified as YYYY-MM-DD in modern Intl implementations.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(atMs));
  } catch {
    return new Date(atMs).toISOString().slice(0, 10);
  }
}

function trustedDigestTimeZone(runtime: PendantInsightsMemoryRuntime): string {
  const configured = runtime.getSetting?.("TIMEZONE");
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : "UTC";
}

async function withAmbientBudgetLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = ambientBudgetLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(
    () => next,
    () => next,
  );
  ambientBudgetLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (ambientBudgetLocks.get(key) === current) {
      ambientBudgetLocks.delete(key);
    }
  }
}

function budgetKey(identity: PendantInsightsIdentity, dayKey: string): string {
  return `${generationKey(identity)}\u0000${dayKey}`;
}

function serverAmbientDailyCallCap(requestedCap: number): number {
  const raw = process.env.AMBIENT_INSIGHT_MAX_CALLS_PER_DAY;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const serverCap =
    Number.isInteger(parsed) && parsed > 0
      ? parsed
      : AMBIENT_INSIGHT_DEFAULT_DAILY_CALL_CAP;
  return Math.min(requestedCap, serverCap);
}

async function reserveAmbientCall(args: {
  identity: PendantInsightsIdentity;
  dayKey: string;
  dailyCallCap: number;
  kind: PendantInsightsKind;
  now: number;
  minIntervalMs: number;
  persistedCallCount?: number;
  persistedRollupAt?: number;
  callCount?: number;
}): Promise<{ ok: true } | { ok: false; skip: PendantInsightsSkipReason }> {
  const key = budgetKey(args.identity, args.dayKey);
  return withAmbientBudgetLock(key, async () => {
    if (args.kind === "digest" && ambientDigests.has(key)) {
      return { ok: false, skip: "digest-already-generated" };
    }
    const inProcessUsed = ambientDailyCalls.get(key) ?? 0;
    const used = Math.max(inProcessUsed, args.persistedCallCount ?? 0);
    ambientDailyCalls.set(key, used);
    const callCount = args.callCount ?? 1;
    if (used + callCount > args.dailyCallCap) {
      return { ok: false, skip: "budget-exhausted" };
    }
    const previousLastRollupAt = ambientLastRollupAt.get(key) ?? 0;
    const lastRollupAt = Math.max(
      previousLastRollupAt,
      args.persistedRollupAt ?? 0,
    );
    ambientLastRollupAt.set(key, lastRollupAt);
    if (
      args.kind === "rollup" &&
      lastRollupAt > 0 &&
      args.now - lastRollupAt < args.minIntervalMs
    ) {
      return { ok: false, skip: "too-few-segments" };
    }
    ambientDailyCalls.set(key, used + callCount);
    if (args.kind === "rollup") ambientLastRollupAt.set(key, args.now);
    if (args.kind === "digest") ambientDigests.add(key);
    // Reservations count attempted model calls, including provider/parse errors.
    // Otherwise repeated failures could bypass the hard daily cost ceiling.
    return { ok: true };
  });
}

function markAmbientCallSucceeded(args: {
  identity: PendantInsightsIdentity;
  dayKey: string;
  kind: PendantInsightsKind;
}): void {
  const key = budgetKey(args.identity, args.dayKey);
  if (args.kind === "digest") ambientDigests.add(key);
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function ambientState(memory: Memory | null): {
  dayKey?: string;
  dailyCallCount?: number;
  lastSuccessfulRollupEndOrdinal?: number;
  lastSuccessfulRollupAt?: number;
} {
  const metadata = memory?.metadata as Record<string, unknown> | undefined;
  const ambient =
    metadata?.ambient && typeof metadata.ambient === "object"
      ? (metadata.ambient as Record<string, unknown>)
      : undefined;
  return {
    dayKey: typeof ambient?.dayKey === "string" ? ambient.dayKey : undefined,
    dailyCallCount: metadataNumber(ambient, "dailyCallCount"),
    lastSuccessfulRollupEndOrdinal: metadataNumber(
      ambient,
      "lastSuccessfulRollupEndOrdinal",
    ),
    lastSuccessfulRollupAt: metadataNumber(ambient, "lastSuccessfulRollupAt"),
  };
}

function selectAmbientSegments(args: {
  segments: readonly InsightSourceSegment[];
  processedSegmentIds: ReadonlySet<string>;
  /** Compatibility fallback for checkpoints written before processed IDs existed. */
  lastSuccessfulRollupEndOrdinal?: number;
  contextTailSegments: number;
  kind: PendantInsightsKind;
}): { segments: InsightSourceSegment[]; newFinalizedCount: number } {
  const finalized = args.segments
    .filter(
      (segment) =>
        (segment as InsightSourceSegment & { status?: string }).status ===
        "finalized",
    )
    .sort((a, b) => a.ordinal - b.ordinal);
  if (args.kind === "digest") {
    return { segments: finalized, newFinalizedCount: finalized.length };
  }
  const hasProcessedIds = args.processedSegmentIds.size > 0;
  const lastEnd = args.lastSuccessfulRollupEndOrdinal ?? -1;
  const isNew = (segment: InsightSourceSegment): boolean =>
    hasProcessedIds
      ? !args.processedSegmentIds.has(segment.id)
      : segment.ordinal > lastEnd;
  const firstNewIndex = finalized.findIndex(isNew);
  if (firstNewIndex === -1) return { segments: [], newFinalizedCount: 0 };
  const tailStart = Math.max(0, firstNewIndex - args.contextTailSegments);
  const tail = finalized.slice(tailStart, firstNewIndex);
  const newlyFinalized = finalized.slice(firstNewIndex).filter(isNew);
  return {
    segments: [...tail, ...newlyFinalized],
    newFinalizedCount: newlyFinalized.length,
  };
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
  const lines = [
    insights.kind === "digest"
      ? "Pendant end-of-day digest"
      : "Pendant conversation insights",
  ];
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
  if (insights.digest) {
    if (insights.digest.commitments.length > 0) {
      lines.push("Commitments:");
      for (const item of insights.digest.commitments) {
        lines.push(
          `- ${item.text}${item.owner ? ` (owner: ${item.owner})` : ""}`,
        );
      }
    }
    if (insights.digest.followUps.length > 0) {
      lines.push("Follow-ups:");
      for (const item of insights.digest.followUps) {
        lines.push(
          `- ${item.text}${item.owner ? ` (owner: ${item.owner})` : ""}`,
        );
      }
    }
    if (insights.digest.notableMoments.length > 0) {
      lines.push("Notable moments:");
      for (const item of insights.digest.notableMoments) {
        lines.push(`- ${item.text}`);
      }
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
    kind: parsed.data.kind,
  };
  const nowMs = Date.now();
  const mode: PendantInsightsMode = parsed.data.mode;
  const kind = parsed.data.kind;
  const digestTimeZone = trustedDigestTimeZone(runtime);
  const dayKey =
    mode === "ambient" ? localDayKey(nowMs, digestTimeZone) : undefined;
  if (dayKey) identity.dayKey = dayKey;
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
    let segments: ReadonlyArray<InsightSourceSegment> = parsed.data.segments;
    let minSegments = MIN_INSIGHT_SEGMENTS;
    let budgetReservation:
      | { ok: true }
      | { ok: false; skip: PendantInsightsSkipReason }
      | null = null;

    if (mode === "ambient") {
      const ambientConfig = parsed.data.ambient ?? {
        minSegments: AMBIENT_INSIGHT_DEFAULT_MIN_SEGMENTS,
        minIntervalMs: AMBIENT_INSIGHT_DEFAULT_MIN_INTERVAL_MS,
        dailyCallCap: AMBIENT_INSIGHT_DEFAULT_DAILY_CALL_CAP,
        contextTailSegments: 24,
      };
      minSegments = kind === "digest" ? 0 : ambientConfig.minSegments;
      const rollingIdentity: PendantInsightsIdentity = {
        ownerId,
        agentId,
        sessionId: parsed.data.sessionId,
        kind: "rollup",
      };
      const existingRollup = await runtime.getMemoryById(
        pendantInsightsMemoryId(rollingIdentity),
      );
      const state = ambientState(existingRollup);
      const digestIdentity: PendantInsightsIdentity = {
        ...identity,
        kind: "digest",
        dayKey: dayKey ?? localDayKey(nowMs, digestTimeZone),
      };
      const existingDigest = await runtime.getMemoryById(
        pendantInsightsMemoryId(digestIdentity),
      );
      const digestState = ambientState(existingDigest);
      const persistedCallCount = Math.max(
        state.dayKey === dayKey ? (state.dailyCallCount ?? 0) : 0,
        digestState.dayKey === dayKey ? (digestState.dailyCallCount ?? 0) : 0,
      );
      const selected = selectAmbientSegments({
        segments: parsed.data.segments,
        processedSegmentIds: new Set(
          storedSourceSegments(existingRollup).map((source) => source.id),
        ),
        lastSuccessfulRollupEndOrdinal: state.lastSuccessfulRollupEndOrdinal,
        contextTailSegments: ambientConfig.contextTailSegments,
        kind,
      });
      if (
        kind === "rollup" &&
        selected.newFinalizedCount < ambientConfig.minSegments
      ) {
        json(res, {
          ok: false,
          reason:
            selected.newFinalizedCount === 0
              ? "no-new-finalized-segments"
              : "too-few-segments",
        });
        return true;
      }
      if (kind === "digest" && existingDigest) {
        json(res, { ok: false, reason: "digest-already-generated" });
        return true;
      }
      segments = selected.segments;
      // Empty-day digests are persisted deterministically without invoking the
      // model, so they must not consume the LLM-call budget.
      if (segments.length > 0) {
        budgetReservation = await reserveAmbientCall({
          identity,
          dayKey: dayKey ?? localDayKey(nowMs, digestTimeZone),
          dailyCallCap: serverAmbientDailyCallCap(ambientConfig.dailyCallCap),
          kind,
          now: nowMs,
          minIntervalMs: ambientConfig.minIntervalMs,
          persistedCallCount,
          persistedRollupAt: state.lastSuccessfulRollupAt,
          callCount:
            kind === "digest"
              ? chunkAmbientDigestSegments(
                  segments,
                  parsed.data.maxTranscriptChars,
                ).length
              : 1,
        });
        if (!budgetReservation.ok) {
          json(res, { ok: false, reason: budgetReservation.skip });
          return true;
        }
      }
    }

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

    const generationArgs = {
      segments,
      runModel,
      priorSummary: parsed.data.priorSummary,
      maxTranscriptChars: parsed.data.maxTranscriptChars,
      dayKey,
      signal: controller.signal,
    };
    const result =
      mode === "ambient" && kind === "digest" && dayKey
        ? await generateAmbientDigest({ ...generationArgs, dayKey })
        : await generatePendantInsights({
            ...generationArgs,
            minSegments,
            kind,
          });
    if (res.destroyed) {
      return true;
    }
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
        persistEmpty: mode === "ambient",
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
    if (mode === "ambient" && dayKey) {
      markAmbientCallSucceeded({ identity, dayKey, kind });
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
