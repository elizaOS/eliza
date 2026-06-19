CREATE TABLE IF NOT EXISTS app_image_generation_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  charge_id uuid,
  charge jsonb,
  provider_result jsonb,
  generation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_body jsonb,
  error_code text,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_image_generation_idempotency_key_idx
  ON app_image_generation_idempotency(key);
CREATE INDEX IF NOT EXISTS app_image_generation_idempotency_app_user_idx
  ON app_image_generation_idempotency(app_id, user_id);
CREATE INDEX IF NOT EXISTS app_image_generation_idempotency_expires_idx
  ON app_image_generation_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS app_image_generation_idempotency_status_idx
  ON app_image_generation_idempotency(status);
