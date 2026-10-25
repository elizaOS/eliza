/** Verifies signed lifecycle completion from the isolated sandbox journal before declaring acceptance. */
import type { Client } from "pg";

export async function hasCompletedSandboxEvent(
  db: Client,
  subscriptionId: string,
  eventType: string,
): Promise<boolean> {
  const result = await db.query<{ complete: boolean }>(
    `SELECT
      NOT EXISTS (
        SELECT 1 FROM webhook_events
        WHERE app_billing_trigger IS NOT NULL
          AND (app_billing_completed_at IS NULL OR app_billing_error_code IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM billing_subscription_event_receipts
        WHERE status NOT IN ('applied','ignored') OR error_code IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM webhook_events w
        JOIN billing_subscription_event_receipts r
          ON r.provider_event_id=w.app_billing_trigger->'event'->>'eventId'
          AND r.payload_digest=w.payload_hash
        WHERE w.app_billing_trigger->'event'->>'objectId'=$1
          AND w.app_billing_trigger->'event'->>'eventType'=$2
          AND w.app_billing_completed_at IS NOT NULL
          AND w.app_billing_error_code IS NULL
          AND r.provider_object_id=$1 AND r.event_type=$2
          AND r.status='applied' AND r.error_code IS NULL
      ) AS complete`,
    [subscriptionId, eventType],
  );
  return result.rows[0]?.complete === true;
}
