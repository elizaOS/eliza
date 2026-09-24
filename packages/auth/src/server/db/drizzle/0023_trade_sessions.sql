CREATE TABLE IF NOT EXISTS "trade_sessions" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "venue" varchar(64) NOT NULL,
  "wallet_id" varchar(128) NOT NULL,
  "status" varchar(32) NOT NULL,
  "daily_spend_usd" numeric(18, 6) DEFAULT '0' NOT NULL,
  "daily_cap_usd" numeric(18, 6) DEFAULT '100' NOT NULL,
  "per_order_cap_usd" numeric(18, 6) NOT NULL,
  "leverage_cap" numeric(10, 4) NOT NULL,
  "allowed_assets" text[] DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD CONSTRAINT "trade_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD CONSTRAINT "trade_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_sessions_agent_venue_status_idx" ON "trade_sessions" USING btree ("agent_id","venue","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_sessions_tenant_idx" ON "trade_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_sessions_expires_at_idx" ON "trade_sessions" USING btree ("expires_at");
