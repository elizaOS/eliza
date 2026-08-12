CREATE TABLE IF NOT EXISTS "oauth_success_proof_tickets" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"connection_id" text,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_success_proof_tickets_expires_at_idx" ON "oauth_success_proof_tickets" USING btree ("expires_at");
