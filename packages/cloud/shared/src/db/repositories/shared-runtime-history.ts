// Persists shared runtime history records for cloud services through the shared DB boundary.
import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import { mergeSharedRuntimeHistoryMessages } from "../../lib/services/shared-runtime/shared-runtime-history-policy";
import { dbRead, dbWrite } from "../client";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import { jsonbParam } from "../utils/jsonb";

export { mergeSharedRuntimeHistoryMessages } from "../../lib/services/shared-runtime/shared-runtime-history-policy";

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
   * Distinct agents with shared-runtime activity since `since`, most recent
   * first, capped. Powers the keep-warm cron's hot set: rows in this table
   * exist only for shared-runtime conversations, so membership alone marks a
   * shared agent worth re-warming.
   */
  async listRecentlyActiveAgentIds(since: Date, limit: number): Promise<string[]> {
    const latestActivityAt = max(sharedRuntimeHistory.updated_at);
    const rows = await dbRead
      .select({
        agentId: sharedRuntimeHistory.agent_id,
        latestActivityAt,
      })
      .from(sharedRuntimeHistory)
      .where(gt(sharedRuntimeHistory.updated_at, since))
      .groupBy(sharedRuntimeHistory.agent_id)
      .orderBy(desc(latestActivityAt), asc(sharedRuntimeHistory.agent_id))
      .limit(limit);
    return rows.map((row) => row.agentId);
  }

  /**
   * List all channel IDs for an agent's shared-runtime history. Used during
   * agent deletion to identify which Durable Object rooms need purging.
   */
  async listChannelsByAgent(agentId: string): Promise<string[]> {
    const rows = await dbRead.query.sharedRuntimeHistory.findMany({
      where: eq(sharedRuntimeHistory.agent_id, agentId),
      columns: { channel_id: true },
    });
    return rows.map((r) => r.channel_id);
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
