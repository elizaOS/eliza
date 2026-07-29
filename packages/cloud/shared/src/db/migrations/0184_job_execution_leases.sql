CREATE TABLE IF NOT EXISTS "job_execution_leases" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"execution_generation" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_execution_leases" ADD CONSTRAINT "job_execution_leases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_execution_leases_expires_idx" ON "job_execution_leases" USING btree ("expires_at");
