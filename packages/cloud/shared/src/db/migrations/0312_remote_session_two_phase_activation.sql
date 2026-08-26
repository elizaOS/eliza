-- Keep consumed remote-target grants non-authoritative until the target proves
-- that the exact grant is durable in its local replay journal.
ALTER TABLE "remote_sessions" DROP CONSTRAINT IF EXISTS "remote_sessions_status_check";
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_status_check"
  CHECK ("status" IN ('pending', 'activating', 'active', 'denied', 'revoked', 'expired'));
