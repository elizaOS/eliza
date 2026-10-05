ALTER TABLE "approval_queue" ADD COLUMN IF NOT EXISTS "requested_by_type" varchar(32);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN IF NOT EXISTS "requested_by_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN IF NOT EXISTS "resolved_by_type" varchar(32);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN IF NOT EXISTS "resolved_by_id" varchar(255);
