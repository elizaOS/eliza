-- Tenant-bound Redis reservation handles. v1 remains readable for historical
-- generations, while every v2 handle must carry the exact tenant namespace used
-- by cumulative-spend:v2 keys (including the count-stream handle).
ALTER TABLE "provider_action_reservation_generations"
  DROP CONSTRAINT "provider_action_reservation_generations_shape_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_reservation_generations"
  ADD CONSTRAINT "provider_action_reservation_generations_shape_chk" CHECK (
    "generation" > 0 AND "phase" IN ('decision','execution')
    AND "state" IN ('pending','needs_attention','settled','released') AND "attempts" >= 0
    AND jsonb_typeof("handles") = 'object'
    AND "handles"->>'schemaVersion' IN (
      'steward.provider-policy-reservations.v1',
      'steward.provider-policy-reservations.v2'
    )
    AND ("handles"->>'generation')::integer = "generation" AND "handles"->>'phase' = "phase"
    AND jsonb_typeof("handles"->'cumulativeSpend') = 'array'
    AND (jsonb_array_length("handles"->'cumulativeSpend') > 0 OR
      ("handles" ? 'windowedInvoke' AND "handles"->'windowedInvoke' <> 'null'::jsonb))
    AND (
      "handles"->>'schemaVersion' = 'steward.provider-policy-reservations.v1'
      OR (
        jsonb_array_length(jsonb_path_query_array(
          "handles", '$.cumulativeSpend[*].stream.tenantId ? (@.type() == "string" && @ != "")'
        )) = jsonb_array_length("handles"->'cumulativeSpend')
        AND jsonb_path_query_array("handles", '$.cumulativeSpend[*].stream.tenantId')
          <@ jsonb_build_array("tenant_id")
        AND (
          "handles"->'windowedInvoke' = 'null'::jsonb
          OR (
            jsonb_typeof("handles"->'windowedInvoke'->'tenantId') = 'string'
            AND length("handles"->'windowedInvoke'->>'tenantId') > 0
            AND "handles"->'windowedInvoke'->>'tenantId' = "tenant_id"
          )
        )
      )
    )
    AND (("state" IN ('pending','needs_attention') AND "reconciled_at" IS NULL) OR
      ("state" IN ('settled','released') AND "reconciled_at" IS NOT NULL))
  );
--> statement-breakpoint
