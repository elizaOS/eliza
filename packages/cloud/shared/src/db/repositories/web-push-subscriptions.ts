// Persists Web Push subscription rows through the shared DB boundary.
// Used by the subscription routes (POST/DELETE) and the cloud push sender
// (list-by-user+agent, prune-gone).
import { and, eq, inArray } from "drizzle-orm";
import type { StoredPushSubscription } from "../../lib/web-push/sender";
import { dbRead, dbWrite } from "../client";
import { type WebPushSubscription, webPushSubscriptions } from "../schemas/web-push-subscriptions";

export interface UpsertWebPushSubscriptionInput {
  userId: string;
  agentId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Map a persisted row to the sender's `StoredPushSubscription` shape. */
export function toStoredSubscription(
  row: Pick<WebPushSubscription, "endpoint" | "p256dh" | "auth">,
): StoredPushSubscription {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

export const webPushSubscriptionsRepository = {
  /**
   * Insert or refresh a subscription. The (endpoint, agent) pair is unique, so a
   * repeat subscribe for the SAME device+agent rotates the keys/owner in place,
   * while the SAME device subscribing to a DIFFERENT agent adds a new row (it
   * does not clobber the first agent's subscription).
   */
  async upsert(input: UpsertWebPushSubscriptionInput): Promise<WebPushSubscription> {
    const [row] = await dbWrite
      .insert(webPushSubscriptions)
      .values({
        user_id: input.userId,
        agent_id: input.agentId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
      })
      .onConflictDoUpdate({
        target: [webPushSubscriptions.endpoint, webPushSubscriptions.agent_id],
        set: {
          user_id: input.userId,
          p256dh: input.p256dh,
          auth: input.auth,
          updated_at: new Date(),
        },
      })
      .returning();
    return row;
  },

  /**
   * Delete a subscription by endpoint, scoped to the owning user so one user
   * can't unsubscribe another's device.
   */
  async deleteByEndpoint(userId: string, endpoint: string): Promise<number> {
    const rows = await dbWrite
      .delete(webPushSubscriptions)
      .where(
        and(eq(webPushSubscriptions.user_id, userId), eq(webPushSubscriptions.endpoint, endpoint)),
      )
      .returning({ id: webPushSubscriptions.id });
    return rows.length;
  },

  /** All subscriptions for a (user, agent) — the fan-out target for a push. */
  async listForUserAgent(userId: string, agentId: string): Promise<WebPushSubscription[]> {
    return dbRead
      .select()
      .from(webPushSubscriptions)
      .where(
        and(eq(webPushSubscriptions.user_id, userId), eq(webPushSubscriptions.agent_id, agentId)),
      );
  },

  /**
   * Prune dead endpoints (those that returned 404/410 from the push service).
   * Called by the sender after a batch send. No-op on an empty list.
   */
  async pruneEndpoints(endpoints: string[]): Promise<number> {
    if (endpoints.length === 0) return 0;
    const rows = await dbWrite
      .delete(webPushSubscriptions)
      .where(inArray(webPushSubscriptions.endpoint, endpoints))
      .returning({ id: webPushSubscriptions.id });
    return rows.length;
  },
};
