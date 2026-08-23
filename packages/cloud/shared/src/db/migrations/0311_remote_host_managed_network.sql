ALTER TABLE "remote_hosts"
  ADD COLUMN IF NOT EXISTS "headscale_hostname" text,
  ADD COLUMN IF NOT EXISTS "headscale_preauth_key_id" text,
  ADD COLUMN IF NOT EXISTS "headscale_cleanup_pending" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "headscale_cleanup_error" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_hosts_headscale_cleanup_pending_idx"
  ON "remote_hosts" ("headscale_cleanup_pending");
