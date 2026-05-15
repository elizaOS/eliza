CREATE TABLE "session_file_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_session_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"snapshot_type" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_restore_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_session_id" uuid NOT NULL,
	"old_sandbox_id" text,
	"new_sandbox_id" text,
	"files_restored" integer DEFAULT 0 NOT NULL,
	"restore_duration_ms" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "session_file_snapshots" ADD CONSTRAINT "session_file_snapshots_sandbox_session_id_app_sandbox_sessions_id_fk" FOREIGN KEY ("sandbox_session_id") REFERENCES "public"."app_sandbox_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_restore_history" ADD CONSTRAINT "session_restore_history_sandbox_session_id_app_sandbox_sessions_id_fk" FOREIGN KEY ("sandbox_session_id") REFERENCES "public"."app_sandbox_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_file_snapshots_session_idx" ON "session_file_snapshots" USING btree ("sandbox_session_id");--> statement-breakpoint
CREATE INDEX "session_file_snapshots_session_path_idx" ON "session_file_snapshots" USING btree ("sandbox_session_id","file_path");--> statement-breakpoint
CREATE INDEX "session_file_snapshots_created_at_idx" ON "session_file_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "session_restore_history_session_idx" ON "session_restore_history" USING btree ("sandbox_session_id");--> statement-breakpoint
CREATE INDEX "generations_org_status_user_created_idx" ON "generations" USING btree ("organization_id","status","user_id","created_at");