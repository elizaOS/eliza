CREATE TABLE IF NOT EXISTS "tenant_db_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'direct_pg' NOT NULL,
	"host" text NOT NULL,
	"admin_dsn_encrypted" text NOT NULL,
	"max_databases" integer DEFAULT 2000 NOT NULL,
	"database_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_db_clusters_active_idx" ON "tenant_db_clusters" USING btree ("is_active");
