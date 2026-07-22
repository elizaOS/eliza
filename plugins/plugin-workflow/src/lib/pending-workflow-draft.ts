/**
 * Conversation-scoped persistence for workflow drafts awaiting user input.
 * The canonical owner and room form the isolation boundary shared by the
 * WORKFLOW action and PENDING_WORKFLOW_DRAFT provider.
 */

import { ElizaError, type IAgentRuntime, type Memory } from '@elizaos/core';
import type { WorkflowDraft } from '../types/index';

/** Maximum idle lifetime for a conversation's pending clarification draft. */
export const PENDING_WORKFLOW_DRAFT_TTL_MS = 30 * 60 * 1000;

/** Canonical cache identity shared by workflow actions and prompt providers. */
export interface PendingWorkflowDraftScope {
  ownerEntityId: string;
  roomId: string;
  cacheKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowDraft(value: unknown): value is WorkflowDraft {
  if (!isRecord(value) || !isRecord(value.workflow)) return false;
  return (
    typeof value.prompt === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.workflow.name === 'string' &&
    Array.isArray(value.workflow.nodes) &&
    isRecord(value.workflow.connections)
  );
}

/** Builds an owner-and-room-isolated key for a workflow chat turn. */
export function getPendingWorkflowDraftScope(
  message: Memory,
  ownerEntityId: string
): PendingWorkflowDraftScope {
  const owner = ownerEntityId.trim();
  const roomId = typeof message.roomId === 'string' ? message.roomId.trim() : '';
  if (!owner || !roomId) {
    throw new ElizaError('Pending workflow draft scope is unavailable', {
      code: 'WORKFLOW_PENDING_DRAFT_SCOPE_UNAVAILABLE',
      context: { ownerEntityId: owner || null, roomId: roomId || null },
      severity: 'ephemeral',
    });
  }
  return {
    ownerEntityId: owner,
    roomId,
    cacheKey: `workflow_draft:v2:${encodeURIComponent(owner)}:room:${encodeURIComponent(roomId)}`,
  };
}

/** Reads a valid pending draft and removes it when its conversation TTL expires. */
export async function readPendingWorkflowDraft(
  runtime: IAgentRuntime,
  scope: PendingWorkflowDraftScope,
  now = Date.now()
): Promise<WorkflowDraft | null> {
  const value = await runtime.getCache<unknown>(scope.cacheKey);
  if (value === undefined) return null;
  if (!isWorkflowDraft(value)) {
    throw new ElizaError('Pending workflow draft cache entry is invalid', {
      code: 'WORKFLOW_PENDING_DRAFT_INVALID',
      context: { cacheKey: scope.cacheKey },
      severity: 'ephemeral',
    });
  }
  if (value.userId !== scope.ownerEntityId) {
    throw new ElizaError('Pending workflow draft owner does not match its cache scope', {
      code: 'WORKFLOW_PENDING_DRAFT_OWNER_MISMATCH',
      context: {
        cacheKey: scope.cacheKey,
        cachedOwnerEntityId: value.userId,
        ownerEntityId: scope.ownerEntityId,
      },
      severity: 'ephemeral',
    });
  }
  if (now - value.createdAt <= PENDING_WORKFLOW_DRAFT_TTL_MS) return value;

  // Cache deletion is idempotent: adapters may return false when a concurrent
  // turn already removed the key, while storage failures throw.
  await runtime.deleteCache(scope.cacheKey);
  return null;
}

/** Persists a draft only when its owner matches the canonical cache scope. */
export async function persistPendingWorkflowDraft(
  runtime: IAgentRuntime,
  scope: PendingWorkflowDraftScope,
  draft: WorkflowDraft
): Promise<void> {
  if (draft.userId !== scope.ownerEntityId) {
    throw new ElizaError('Pending workflow draft cannot be stored outside its owner scope', {
      code: 'WORKFLOW_PENDING_DRAFT_STORE_OWNER_MISMATCH',
      context: {
        cacheKey: scope.cacheKey,
        draftOwnerEntityId: draft.userId,
        ownerEntityId: scope.ownerEntityId,
      },
      severity: 'ephemeral',
    });
  }
  const persisted = await runtime.setCache(scope.cacheKey, draft);
  if (!persisted) {
    throw new ElizaError('Pending workflow draft could not be persisted', {
      code: 'WORKFLOW_PENDING_DRAFT_STORE_FAILED',
      context: { cacheKey: scope.cacheKey },
      severity: 'ephemeral',
    });
  }
}

/** Clears a known pending draft after deployment or explicit cancellation. */
export async function clearPendingWorkflowDraft(
  runtime: IAgentRuntime,
  scope: PendingWorkflowDraftScope
): Promise<void> {
  await runtime.deleteCache(scope.cacheKey);
}
