import { and, eq } from "drizzle-orm";

import { dbRead, dbWrite } from "../client";
import {
  type SharedRuntimeHistoryMessage,
  sharedRuntimeHistory,
} from "../schemas/shared-runtime-history";
import { jsonbParam } from "../utils/jsonb";

/**
 * Durable persistence for shared-runtime (Tier-0) conversation history. Replaces
 * the request-cache store (a no-op when `CACHE_ENABLED=false` on the Worker) so
 * a shared agent keeps cross-turn memory and `GET .../messages` returns history.
 * One canonical row per `(agentId, channelId)`, upserted with the capped list.
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
        // Bind JSONB explicitly as a JSON string + cast (Neon serverless driver
        // can mis-bind raw JS arrays/objects as query params).
        messages: jsonbParam(messages) as unknown as SharedRuntimeHistoryMessage[],
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [sharedRuntimeHistory.agent_id, sharedRuntimeHistory.channel_id],
        set: {
          messages: jsonbParam(messages) as unknown as SharedRuntimeHistoryMessage[],
          updated_at: now,
        },
      });
  }
}

export const sharedRuntimeHistoryRepository = new SharedRuntimeHistoryRepository();
