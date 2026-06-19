/**
 * Test helpers for asserting on trajectory rows produced by the runtime.
 *
 * Trajectories are written asynchronously, so loaders settle for a short
 * window before reading. Filtering happens in JS over the parsed `metadata`
 * column — the underlying SQL is `SELECT * FROM trajectories ORDER BY
 * created_at DESC` so we can rely on row order.
 */

import {
  loadPersistedTrajectoryRows,
  loadTrajectoryById,
  type PersistedTrajectory,
} from "@elizaos/agent";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { expect } from "vitest";

const SETTLE_DELAY_MS = 500;

interface TrajectoryRowMetaShape {
  webConversation?: { scope?: string; conversationId?: string };
  taskId?: string;
  surface?: string;
  surfaceVersion?: number;
  pageId?: string;
  sourceConversationId?: string;
  [key: string]: unknown;
}

function parseRowMetadata(value: unknown): TrajectoryRowMetaShape {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed as TrajectoryRowMetaShape;
      }
    } catch {
      return {};
    }
  } else if (value && typeof value === "object") {
    return value as TrajectoryRowMetaShape;
  }
  return {};
}

function readRowMetadata(row: Record<string, unknown>): unknown {
  return (
    row.metadata_json ??
    row.metadataJson ??
    row.metadataJSON ??
    row.METADATA_JSON ??
    row.metadata
  );
}

async function settleTrajectories(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
}

export async function loadLatestTrajectoryForScope(
  runtime: IAgentRuntime,
  scope: string,
  options: { roomId?: UUID; pollMs?: number; pollIntervalMs?: number } = {},
): Promise<PersistedTrajectory | null> {
  await settleTrajectories();
  const totalPoll = Math.max(0, options.pollMs ?? 2000);
  const interval = Math.max(50, options.pollIntervalMs ?? 250);
  const deadline = Date.now() + totalPoll;

  while (true) {
    const rows = (await loadPersistedTrajectoryRows(runtime, 200)) ?? [];
    for (const row of rows) {
      const meta = parseRowMetadata(readRowMetadata(row));
      if (meta.webConversation?.scope !== scope) continue;
      const id = String(row.id ?? "");
      if (!id) continue;
      const trajectory = await loadTrajectoryById(runtime, id);
      if (!trajectory) continue;
      if (
        options.roomId &&
        trajectory.metadata?.roomId &&
        trajectory.metadata.roomId !== options.roomId
      ) {
        continue;
      }
      return trajectory;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function expectTrajectoryScopeMetadata(
  trajectory: PersistedTrajectory,
  scope: string,
  options: { surfaceVersion?: number } = {},
): void {
  const meta = trajectory.metadata as TrajectoryRowMetaShape;
  expect(meta.webConversation?.scope).toBe(scope);
  expect(meta.taskId).toBe(scope);
  expect(meta.surface).toBe("page-scoped");
  if (typeof options.surfaceVersion === "number") {
    expect(meta.surfaceVersion).toBe(options.surfaceVersion);
  }
}

export function expectProviderAccessed(
  trajectory: PersistedTrajectory,
  providerName: string,
): void {
  const accessed = trajectory.steps.flatMap((step) =>
    Array.isArray(step.providerAccesses) ? step.providerAccesses : [],
  );
  const names = accessed.map((entry) =>
    typeof (entry as { providerName?: unknown }).providerName === "string"
      ? ((entry as { providerName: string }).providerName as string)
      : "",
  );
  expect(
    names.includes(providerName),
    `Expected provider "${providerName}" to be accessed in trajectory; observed: ${names.join(", ") || "(none)"}`,
  ).toBe(true);
}

/**
 * Stamp a page-scoped conversation marker onto a room so the
 * page-scoped-context provider activates for that room. Mirrors the
 * production write path in conversation-routes.ts (buildConversationRoomMetadata).
 */
export async function stampPageScopedRoomMetadata(
  runtime: IAgentRuntime,
  roomId: UUID,
  scope: string,
  options: {
    conversationId?: string;
    pageId?: string;
    sourceConversationId?: string;
  } = {},
): Promise<void> {
  const adapter = runtime.adapter as typeof runtime.adapter & {
    updateRoom?: (room: {
      id: UUID;
      metadata: Record<string, unknown>;
    }) => Promise<void>;
    getRoom?: (id: UUID) => Promise<{ metadata?: unknown } | null>;
  };
  if (!adapter?.updateRoom) {
    throw new Error("runtime.adapter.updateRoom is unavailable");
  }
  const existing = (await runtime.getRoom(roomId)) ?? { metadata: {} };
  const baseMetadata =
    existing.metadata && typeof existing.metadata === "object"
      ? { ...(existing.metadata as Record<string, unknown>) }
      : {};
  baseMetadata.webConversation = {
    conversationId: options.conversationId ?? `test-conv-${roomId}`,
    scope,
    ...(options.pageId ? { pageId: options.pageId } : {}),
    ...(options.sourceConversationId
      ? { sourceConversationId: options.sourceConversationId }
      : {}),
  };
  await adapter.updateRoom({
    ...(existing as { id?: UUID }),
    id: roomId,
    metadata: baseMetadata,
  });
}
