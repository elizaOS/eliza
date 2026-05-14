import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../repository.js";
import type {
  ThreadSourceRef,
  WorkThread,
  WorkThreadEventType,
  WorkThreadListFilter,
  WorkThreadStatus,
} from "./types.js";

export interface CreateWorkThreadInput {
  ownerEntityId?: string | null;
  title: string;
  summary: string;
  currentPlanSummary?: string | null;
  primarySourceRef: ThreadSourceRef;
  sourceRefs?: ThreadSourceRef[];
  participantEntityIds?: string[];
  lastMessageMemoryId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateWorkThreadInput {
  status?: WorkThreadStatus;
  title?: string;
  summary?: string;
  currentPlanSummary?: string | null;
  primarySourceRef?: ThreadSourceRef;
  sourceRefs?: ThreadSourceRef[];
  participantEntityIds?: string[];
  currentScheduledTaskId?: string | null;
  workflowRunId?: string | null;
  approvalId?: string | null;
  lastMessageMemoryId?: string | null;
  metadata?: Record<string, unknown>;
  eventType?: WorkThreadEventType;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface MergeWorkThreadsInput {
  /** The thread that will absorb the sources. Must be active and mutable. */
  targetWorkThreadId: string;
  /** Threads being merged INTO the target. Must be non-empty, active, mutable. */
  sourceWorkThreadIds: string[];
  /**
   * Idempotency key for this merge attempt. If a merge with the same
   * `mergeRequestId` has already committed against this target, this call is
   * a no-op and returns the recorded result.
   *
   * Derive from `(targetId, sortedSourceIds, currentTurnId)` so retries within
   * the same turn deduplicate.
   */
  mergeRequestId: string;
  /** Patch applied to the target (summary, instruction, etc). */
  patch?: {
    summary?: string;
    instruction?: string | null;
    lastMessageMemoryId?: string | null;
    participantsToAdd?: string[];
  };
  reason?: string | null;
}

export interface MergeWorkThreadsResult {
  /** Updated target thread (post-merge). */
  target: WorkThread;
  /** Updated source threads (status=stopped, metadata.mergedIntoWorkThreadId). */
  sources: WorkThread[];
  /** True when this is the first time this mergeRequestId committed. */
  freshlyMerged: boolean;
}

export interface WorkThreadStore {
  create(input: CreateWorkThreadInput): Promise<WorkThread>;
  get(workThreadId: string): Promise<WorkThread | null>;
  list(filter?: WorkThreadListFilter): Promise<WorkThread[]>;
  update(
    workThreadId: string,
    input: UpdateWorkThreadInput,
  ): Promise<WorkThread | null>;
  appendEvent(
    workThreadId: string,
    type: WorkThreadEventType,
    args?: { reason?: string; detail?: Record<string, unknown> },
  ): Promise<void>;
  /**
   * Atomic thread merge. All UPDATEs + event INSERTs commit together or none.
   * Uses optimistic concurrency: every thread's `version` must match the read.
   * Idempotent on `mergeRequestId`.
   *
   * Throws `OptimisticLockError` if any version check fails. Throws standard
   * errors on validation (`NotFoundError`, `MergeBlockedError`).
   */
  merge(input: MergeWorkThreadsInput): Promise<MergeWorkThreadsResult>;
}

export class MergeBlockedError extends Error {
  readonly code: string;
  readonly threadId?: string;
  constructor(args: { code: string; message: string; threadId?: string }) {
    super(args.message);
    this.name = "MergeBlockedError";
    this.code = args.code;
    this.threadId = args.threadId;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function compactText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeSourceRefs(
  primary: ThreadSourceRef,
  refs: readonly ThreadSourceRef[] = [],
): ThreadSourceRef[] {
  const seen = new Set<string>();
  const result: ThreadSourceRef[] = [];
  for (const ref of [primary, ...refs]) {
    if (
      !ref ||
      typeof ref.connector !== "string" ||
      ref.connector.length === 0
    ) {
      continue;
    }
    const key = [
      ref.connector,
      ref.accountId ?? "",
      ref.grantId ?? "",
      ref.roomId ?? "",
      ref.externalThreadId ?? "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      connector: ref.connector,
      ...(ref.channelName ? { channelName: ref.channelName } : {}),
      ...(ref.channelKind ? { channelKind: ref.channelKind } : {}),
      ...(ref.roomId ? { roomId: ref.roomId } : {}),
      ...(ref.externalThreadId
        ? { externalThreadId: ref.externalThreadId }
        : {}),
      ...(ref.accountId ? { accountId: ref.accountId } : {}),
      ...(ref.grantId ? { grantId: ref.grantId } : {}),
      canRead: ref.canRead ?? true,
      canMutate: ref.canMutate ?? false,
    });
  }
  return result;
}

export function createWorkThreadStore(
  runtime: IAgentRuntime,
  agentId = runtime.agentId,
): WorkThreadStore {
  const repo = new LifeOpsRepository(runtime);
  return {
    async create(input): Promise<WorkThread> {
      const timestamp = isoNow();
      const sourceRefs = normalizeSourceRefs(
        input.primarySourceRef,
        input.sourceRefs,
      );
      const thread: WorkThread = {
        id: crypto.randomUUID(),
        agentId,
        ownerEntityId: input.ownerEntityId ?? null,
        status: "active",
        title: compactText(input.title || "Active thread", 120),
        summary: compactText(
          input.summary || input.title || "Active thread",
          500,
        ),
        currentPlanSummary: input.currentPlanSummary ?? null,
        primarySourceRef: sourceRefs[0] ?? input.primarySourceRef,
        sourceRefs,
        participantEntityIds: [...new Set(input.participantEntityIds ?? [])],
        currentScheduledTaskId: null,
        workflowRunId: null,
        approvalId: null,
        lastMessageMemoryId: input.lastMessageMemoryId ?? null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
        metadata: input.metadata ?? {},
      };
      await repo.upsertWorkThread(agentId, thread);
      await this.appendEvent(thread.id, "created", {
        detail: { sourceRef: thread.primarySourceRef },
      });
      return thread;
    },

    get(workThreadId) {
      return repo.getWorkThread(agentId, workThreadId);
    },

    list(filter = {}) {
      return repo.listWorkThreads(agentId, filter);
    },

    async update(workThreadId, input): Promise<WorkThread | null> {
      const current = await repo.getWorkThread(agentId, workThreadId);
      if (!current) {
        return null;
      }
      const timestamp = isoNow();
      const primary = input.primarySourceRef ?? current.primarySourceRef;
      const sourceRefs = input.sourceRefs
        ? normalizeSourceRefs(primary, input.sourceRefs)
        : current.sourceRefs;
      const next: WorkThread = {
        ...current,
        status: input.status ?? current.status,
        title:
          typeof input.title === "string"
            ? compactText(input.title, 120)
            : current.title,
        summary:
          typeof input.summary === "string"
            ? compactText(input.summary, 500)
            : current.summary,
        currentPlanSummary:
          input.currentPlanSummary !== undefined
            ? input.currentPlanSummary
            : current.currentPlanSummary,
        primarySourceRef: primary,
        sourceRefs,
        participantEntityIds: input.participantEntityIds
          ? [...new Set(input.participantEntityIds)]
          : current.participantEntityIds,
        currentScheduledTaskId:
          input.currentScheduledTaskId !== undefined
            ? input.currentScheduledTaskId
            : current.currentScheduledTaskId,
        workflowRunId:
          input.workflowRunId !== undefined
            ? input.workflowRunId
            : current.workflowRunId,
        approvalId:
          input.approvalId !== undefined
            ? input.approvalId
            : current.approvalId,
        lastMessageMemoryId:
          input.lastMessageMemoryId !== undefined
            ? input.lastMessageMemoryId
            : current.lastMessageMemoryId,
        metadata: input.metadata
          ? { ...(current.metadata ?? {}), ...input.metadata }
          : current.metadata,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      };
      await repo.upsertWorkThread(agentId, next);
      await this.appendEvent(workThreadId, input.eventType ?? "updated", {
        reason: input.reason,
        detail: input.detail,
      });
      return next;
    },

    async appendEvent(workThreadId, type, args = {}): Promise<void> {
      await repo.appendWorkThreadEvent({
        id: crypto.randomUUID(),
        agentId,
        workThreadId,
        occurredAt: isoNow(),
        type,
        reason: args.reason ?? null,
        detail: args.detail,
      });
    },

    async merge(input): Promise<MergeWorkThreadsResult> {
      const sourceIds = [
        ...new Set(input.sourceWorkThreadIds.filter((id) => id && id !== input.targetWorkThreadId)),
      ];
      if (sourceIds.length === 0) {
        throw new MergeBlockedError({
          code: "MISSING_SOURCE_WORK_THREAD_IDS",
          message: "No source work threads provided.",
        });
      }

      // Read target + all sources at a consistent snapshot. These reads are
      // OUTSIDE the transaction — repository.mergeWorkThreadsAtomic will
      // re-check versions inside the transaction.
      const target = await this.get(input.targetWorkThreadId);
      if (!target) {
        throw new MergeBlockedError({
          code: "TARGET_NOT_FOUND",
          message: `Target work thread not found: ${input.targetWorkThreadId}`,
          threadId: input.targetWorkThreadId,
        });
      }

      const sources: WorkThread[] = [];
      for (const sourceId of sourceIds) {
        const source = await this.get(sourceId);
        if (!source) {
          throw new MergeBlockedError({
            code: "SOURCE_NOT_FOUND",
            message: `Source work thread not found: ${sourceId}`,
            threadId: sourceId,
          });
        }
        sources.push(source);
      }

      // Build the post-merge target snapshot.
      const timestamp = isoNow();
      const summary =
        typeof input.patch?.summary === "string"
          ? compactText(input.patch.summary, 500)
          : target.summary;
      const currentPlanSummary =
        typeof input.patch?.instruction === "string" &&
        input.patch.instruction.trim().length > 0
          ? input.patch.instruction.trim()
          : target.currentPlanSummary;
      const mergedSourceRefs = [
        ...target.sourceRefs,
        ...sources.flatMap((source) => source.sourceRefs),
      ];
      const mergedParticipantEntityIds = [
        ...new Set([
          ...target.participantEntityIds,
          ...sources.flatMap((source) => source.participantEntityIds),
          ...(input.patch?.participantsToAdd ?? []),
        ]),
      ];
      const existingMetadata = target.metadata ?? {};
      const existingMergedFrom = (() => {
        const raw = existingMetadata.mergedFromWorkThreadIds;
        return Array.isArray(raw)
          ? raw.filter((value): value is string => typeof value === "string")
          : [];
      })();
      const nextTarget: WorkThread = {
        ...target,
        summary,
        currentPlanSummary,
        sourceRefs: mergedSourceRefs,
        participantEntityIds: mergedParticipantEntityIds,
        lastMessageMemoryId:
          input.patch?.lastMessageMemoryId !== undefined
            ? input.patch.lastMessageMemoryId
            : target.lastMessageMemoryId,
        metadata: {
          ...existingMetadata,
          mergedFromWorkThreadIds: [
            ...new Set([...existingMergedFrom, ...sourceIds]),
          ],
        },
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      };

      // Atomic write via transaction + optimistic concurrency on every row.
      const writeResult = await repo.mergeWorkThreadsAtomic({
        agentId,
        target,
        sources,
        nextTarget,
        mergeRequestId: input.mergeRequestId,
        reason: input.reason ?? null,
        instruction: input.patch?.instruction ?? null,
      });

      // Re-read everything post-commit. We could be clever and return the
      // computed snapshots, but a re-read guarantees we surface what's
      // actually persisted (including the version bumps).
      const refreshedTarget = await this.get(writeResult.targetWorkThreadId);
      if (!refreshedTarget) {
        throw new MergeBlockedError({
          code: "TARGET_VANISHED",
          message: "Target thread missing post-merge — concurrent deletion?",
          threadId: writeResult.targetWorkThreadId,
        });
      }
      const refreshedSources: WorkThread[] = [];
      for (const sourceId of writeResult.sourceWorkThreadIds) {
        const source = await this.get(sourceId);
        if (source) refreshedSources.push(source);
      }

      // Determine if THIS call was the one that committed (vs idempotent hit).
      // If the target's version did not move past our read, it was idempotent.
      const freshlyMerged = refreshedTarget.version > target.version;

      return {
        target: refreshedTarget,
        sources: refreshedSources,
        freshlyMerged,
      };
    },
  };
}
