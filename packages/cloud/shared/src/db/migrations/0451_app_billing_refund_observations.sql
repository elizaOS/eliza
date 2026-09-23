CREATE TABLE IF NOT EXISTS app_billing_refund_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_sequence bigserial NOT NULL CONSTRAINT app_billing_refund_observations_sequence_unique UNIQUE,
  command_id uuid NOT NULL CONSTRAINT app_billing_refund_observations_command_fk REFERENCES billing_subscription_commands(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  request_digest text NOT NULL,
  lifecycle_revision bigint NOT NULL,
  phase_receipt_id uuid NOT NULL,
  phase_generation bigint NOT NULL,
  command_revision bigint NOT NULL,
  execution_generation bigint NOT NULL,
  observation jsonb NOT NULL,
  discovery jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_billing_refund_observations_command_idx ON app_billing_refund_observations(command_id,observation_sequence);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_billing_refund_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||app_billing_refund_canonical_json(v),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) AS x(key,v);
    WHEN 'array' THEN SELECT '['||COALESCE(string_agg(app_billing_refund_canonical_json(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS x(v,n);
    ELSE result := value::text;
  END CASE;
  RETURN result;
END $$;
