CREATE TABLE IF NOT EXISTS "sso_bridge_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"steward_user_id" text NOT NULL,
	"code_challenge" text NOT NULL,
	"claims" jsonb NOT NULL,
	"token_issued_at" timestamp with time zone NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_bridge_codes_expires_at_idx" ON "sso_bridge_codes" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_bridge_logout_markers" (
	"steward_user_id" text PRIMARY KEY NOT NULL,
	"logged_out_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
