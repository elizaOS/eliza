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
    if (!ref || typeof ref.connector !== "string" || ref.connector.length === 0) {
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
      ...(ref.externalThreadId ? { externalThreadId: ref.externalThreadId } : {}),
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
        summary: compactText(input.summary || input.title || "Active thread", 500),
        currentPlanSummary: input.currentPlanSummary ?? null,
        primarySourceRef: sourceRefs[0] ?? input.primarySourceRef,
        sourceRefs,
        participantEntityIds: [...new Set(input.participantEntityIds ?? [])],
        currentScheduledTaskId: null,
        workflowRunId: null,
        approvalId: null,
        lastMessageMemoryId: input.lastMessageMemoryId ?? null,
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
          input.approvalId !== undefined ? input.approvalId : current.approvalId,
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
  };
}
