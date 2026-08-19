-- Reconciles every eligible settled request to one exact provider receipt or aborts.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payment_requests" AS request
    LEFT JOIN LATERAL (
      SELECT
        count(*) AS candidate_count,
        count(*) FILTER (WHERE
          (request."provider" = 'stripe'
            AND request."settlement_proof"->>'stripe_event_id' = event."provider_event_id"
            AND request."settlement_proof"->>'stripe_event_type' = 'checkout.session.completed'
            AND request."settlement_proof"->>'stripe_session_id'
              = request."provider_intent"->>'stripe_session_id'
            AND request."settlement_proof"->>'stripe_payment_intent_id'
              = request."settlement_tx_ref"
            AND jsonb_typeof(request."settlement_proof"->'stripe_amount_total') = 'number'
            AND request."settlement_proof"->>'stripe_amount_total'
              = request."amount_cents"::text
            AND upper(request."settlement_proof"->>'stripe_currency')
              = upper(request."currency")
            AND request."settlement_proof"->>'stripe_payment_status' = 'paid')
          OR
          (request."provider" = 'oxapay'
            AND request."settlement_proof"->>'provider' = 'oxapay'
            AND request."settlement_proof"->>'oxapay_track_id'
              = request."provider_intent"->>'oxapay_track_id'
            AND request."settlement_proof"->>'oxapay_track_id'
              = request."settlement_tx_ref"
            AND request."settlement_proof"->>'oxapay_order_id' = request."id"::text
            AND request."settlement_proof"->>'oxapay_status' = 'paid'
            AND jsonb_typeof(request."settlement_proof"->'oxapay_amount_cents') = 'number'
            AND request."settlement_proof"->>'oxapay_amount_cents'
              = request."amount_cents"::text
            AND upper(request."settlement_proof"->>'oxapay_currency')
              = upper(request."currency"))
        ) AS authority_count
      FROM "payment_request_events" AS event
      WHERE event."payment_request_id" = request."id"
        AND event."event_name" = 'webhook.received'
        AND event."provider_disposition" = 'settled'
        AND event."provider" = request."provider"
        AND event."provider_tx_ref" = request."settlement_tx_ref"
        AND event."provider_event_id" = event."redacted_payload"->>'providerEventId'
        AND event."payload_digest" ~ '^[a-f0-9]{64}$'
        AND event."redacted_payload"->>'paymentRequestId' = request."id"::text
        AND event."redacted_payload"->>'provider' = request."provider"
        AND event."redacted_payload"->>'txRef' = request."settlement_tx_ref"
        AND event."redacted_payload"->>'amountCents' = request."amount_cents"::text
        AND event."redacted_payload"->>'currency' = upper(request."currency")
    ) AS authority ON true
    WHERE request."status" = 'settled'
      AND request."provider" IN ('stripe', 'oxapay')
      AND (
        request."settled_at" IS NULL
        OR request."settlement_tx_ref" IS NULL
        OR jsonb_typeof(request."settlement_proof") IS DISTINCT FROM 'object'
        OR authority.candidate_count <> 1
        OR authority.authority_count <> 1
        OR EXISTS (
          SELECT 1
          FROM jsonb_each(CASE
            WHEN jsonb_typeof(request."settlement_proof") = 'object'
              THEN request."settlement_proof"
            ELSE '{}'::jsonb
          END) AS proof(key, value)
          WHERE jsonb_typeof(proof.value) NOT IN ('string', 'number', 'null')
            OR (request."provider" = 'stripe' AND proof.key NOT IN (
              'stripe_event_id', 'stripe_event_type', 'stripe_session_id',
              'stripe_payment_intent_id', 'stripe_amount_total', 'stripe_currency',
              'stripe_payment_status'
            ))
            OR (request."provider" = 'oxapay' AND proof.key NOT IN (
              'provider', 'oxapay_track_id', 'oxapay_order_id', 'oxapay_status',
              'oxapay_amount_cents', 'oxapay_currency'
            ))
        )
        OR (request."provider" = 'stripe' AND (
          request."settlement_proof"->>'stripe_payment_intent_id'
            IS DISTINCT FROM request."settlement_tx_ref"
          OR request."settlement_proof"->>'stripe_payment_status' IS DISTINCT FROM 'paid'
          OR nullif(btrim(request."settlement_proof"->>'stripe_session_id'), '') IS NULL
        ))
        OR (request."provider" = 'oxapay' AND (
          request."settlement_proof"->>'oxapay_track_id'
            IS DISTINCT FROM request."settlement_tx_ref"
          OR request."settlement_proof"->>'oxapay_order_id' IS DISTINCT FROM request."id"::text
          OR request."settlement_proof"->>'oxapay_status' IS DISTINCT FROM 'paid'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'settled payment request lacks one curated authoritative provider event';
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO "payment_request_receipts" (
  "organization_id", "payment_request_id", "provider", "provider_tx_ref",
  "provider_event_id", "amount_cents", "currency", "settled_at",
  "payload_digest", "settlement_proof"
)
SELECT
  request."organization_id", request."id", request."provider", request."settlement_tx_ref",
  event."provider_event_id", request."amount_cents", upper(request."currency"),
  request."settled_at", event."payload_digest", request."settlement_proof"
FROM "payment_requests" AS request
JOIN "payment_request_events" AS event
  ON event."payment_request_id" = request."id"
 AND event."event_name" = 'webhook.received'
 AND event."provider_disposition" = 'settled'
 AND event."provider" = request."provider"
 AND event."provider_tx_ref" = request."settlement_tx_ref"
WHERE request."status" = 'settled'
  AND request."provider" IN ('stripe', 'oxapay')
  AND NOT EXISTS (
    SELECT 1 FROM "payment_request_receipts" AS receipt
    WHERE receipt."payment_request_id" = request."id"
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payment_requests" AS request
    JOIN "payment_request_events" AS event
      ON event."payment_request_id" = request."id"
     AND event."event_name" = 'webhook.received'
     AND event."provider_disposition" = 'settled'
     AND event."provider" = request."provider"
     AND event."provider_tx_ref" = request."settlement_tx_ref"
    LEFT JOIN "payment_request_receipts" AS receipt
      ON receipt."payment_request_id" = request."id"
    WHERE request."status" = 'settled'
      AND request."provider" IN ('stripe', 'oxapay')
      AND (
        receipt."id" IS NULL
        OR receipt."organization_id" IS DISTINCT FROM request."organization_id"
        OR receipt."provider" IS DISTINCT FROM request."provider"
        OR receipt."provider_tx_ref" IS DISTINCT FROM request."settlement_tx_ref"
        OR receipt."provider_event_id" IS DISTINCT FROM event."provider_event_id"
        OR receipt."amount_cents" IS DISTINCT FROM request."amount_cents"
        OR receipt."currency" IS DISTINCT FROM upper(request."currency")
        OR receipt."settled_at" IS DISTINCT FROM request."settled_at"
        OR receipt."payload_digest" IS DISTINCT FROM event."payload_digest"
        OR receipt."settlement_proof" IS DISTINCT FROM request."settlement_proof"
      )
  ) THEN
    RAISE EXCEPTION 'payment request receipt backfill postcondition failed';
  END IF;
END;
$$;
