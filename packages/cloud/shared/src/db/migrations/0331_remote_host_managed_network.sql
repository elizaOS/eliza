ALTER TABLE "remote_hosts"
  ADD COLUMN IF NOT EXISTS "headscale_hostname" text,
  ADD COLUMN IF NOT EXISTS "headscale_preauth_key_id" text,
  ADD COLUMN IF NOT EXISTS "headscale_cleanup_pending" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "headscale_cleanup_error" text;
--> statement-breakpoint
ALTER TABLE "remote_hosts" DROP CONSTRAINT IF EXISTS "remote_hosts_status_check";
--> statement-breakpoint
ALTER TABLE "remote_hosts" ADD CONSTRAINT "remote_hosts_status_check" CHECK (
  ("status" IN ('pending', 'active') AND "revoked_at" IS NULL)
  OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_hosts_headscale_cleanup_pending_idx"
  ON "remote_hosts" ("headscale_cleanup_pending");
