// Persists shared runtime history records for cloud services through the shared DB boundary.
import { and, eq } from "drizzle-orm";

import { dbRead, dbWrite } from "../client";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import { jsonbParam } from "../utils/jsonb";

function isPersistedMessage(value: unknown): value is SharedRuntimeHistoryMessage {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    ((value as { role?: unknown }).role === "user" ||
      (value as { role?: unknown }).role === "assistant") &&
    typeof (value as { content?: unknown }).content === "string" &&
    (value as { content: string }).content.trim().length > 0
  );
}

function messageIdentity(message: SharedRuntimeHistoryMessage): string {
  return message.id ?? `${message.role}\u0000${message.createdAt ?? ""}\u0000${message.content}`;
}

function chooseMergedMessage(
  current: SharedRuntimeHistoryMessage | undefined,
  incoming: SharedRuntimeHistoryMessage,
): SharedRuntimeHistoryMessage {
  if (!current) return incoming;
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted !== true &&
    incoming.interrupted === true
  ) {
    return current;
  }
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted === true &&
    incoming.interrupted === true &&
    current.content.length > incoming.content.length
  ) {
    return current;
  }
  return incoming;
}

export function mergeSharedRuntimeHistoryMessages(
  current: SharedRuntimeHistoryMessage[],
  incoming: SharedRuntimeHistoryMessage[],
  limit: number,
): SharedRuntimeHistoryMessage[] {
  const merged = new Map<string, SharedRuntimeHistoryMessage>();
  for (const message of [...current, ...incoming]) {
    if (!isPersistedMessage(message)) continue;
    const key = messageIdentity(message);
    merged.set(key, chooseMergedMessage(merged.get(key), message));
  }
  return [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).slice(-limit);
}

/**
 * Durable persistence for shared-runtime (Tier-0) conversation history. Replaces
 * the request-cache store (a no-op when `CACHE_ENABLED=false` on the Worker) so
 * a shared agent keeps cross-turn memory and `GET .../messages` returns history.
 * One canonical row per `(agentId, channelId)`, updated with row-locked merges
 * so late mirrors and direct writers append/update by stable message id.
 */
export class SharedRuntimeHistoryRepository {
  async get(agentId: string, channelId: string): Promise<SharedRuntimeHistoryMessage[]> {
    const row = await dbRead.query.sharedRuntimeHistory.findFirst({
      where: and(
        eq(sharedRuntimeHistory.agent_id, agentId),
        eq(sharedRuntimeHistory.channel_id, channelId),
      ),
    });
    return Array.isArray(row?.messages) ? row.messages : [];
  }

  /**
   * Delete ALL shared-runtime history rows for an agent (every channel),
   * called when the agent itself is deleted. Without this, a shared agent's
   * cross-turn history is orphaned: the canonical `agent_sandboxes` row is
   * gone but its `(agent_id, channel_id)` rows linger forever (no FK cascade —
   * this table is deliberately decoupled from the sandbox/conversation tables).
   * Returns the number of rows removed so the caller can log the cleanup.
   */
  async deleteByAgent(agentId: string): Promise<number> {
    const deleted = await dbWrite
      .delete(sharedRuntimeHistory)
      .where(eq(sharedRuntimeHistory.agent_id, agentId))
      .returning({ channelId: sharedRuntimeHistory.channel_id });
    return deleted.length;
  }

  async upsert(
    agentId: string,
    channelId: string,
    messages: SharedRuntimeHistoryMessage[],
  ): Promise<void> {
    const now = new Date();
    await dbWrite
      .insert(sharedRuntimeHistory)
      .values({
        agent_id: agentId,
        channel_id: channelId,
        // Bind JSONB explicitly as a JSON string (Neon serverless driver can
        // mis-bind raw JS arrays/objects as query params). The insert value
        // type accepts a raw `SQL` expression per column, so no cast is needed.
        messages: jsonbParam(messages),
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        set: {
          messages: jsonbParam(messages),
          updated_at: now,
        },
      });
  }

  async merge(
    agentId: string,
    channelId: string,
    messages: SharedRuntimeHistoryMessage[],
    limit: number,
  ): Promise<SharedRuntimeHistoryMessage[]> {
    const merged = await dbWrite.transaction(async (tx) => {
      const now = new Date();
      await tx
        .insert(sharedRuntimeHistory)
        .values({
          agent_id: agentId,
          channel_id: channelId,
          messages: jsonbParam([]),
          updated_at: now,
        })
        .onConflictDoNothing({
          target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        });
      const [row] = await tx
        .select()
        .from(sharedRuntimeHistory)
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        )
        .for("update")
        .limit(1);
      const next = mergeSharedRuntimeHistoryMessages(
        Array.isArray(row?.messages) ? row.messages : [],
        messages,
        limit,
      );
      await tx
        .update(sharedRuntimeHistory)
        .set({
          messages: jsonbParam(next),
          updated_at: now,
        })
        .where(
          and(
            eq(sharedRuntimeHistory.agent_id, agentId),
            eq(sharedRuntimeHistory.channel_id, channelId),
          ),
        );
      return next;
    });
    return merged;
  }
}

export const sharedRuntimeHistoryRepository = new SharedRuntimeHistoryRepository();
