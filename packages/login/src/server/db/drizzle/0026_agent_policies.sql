CREATE TABLE IF NOT EXISTS "agent_policies" (
  "agent_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "daily_cap_usd" numeric DEFAULT '1000' NOT NULL,
  "per_order_cap_usd" numeric DEFAULT '500' NOT NULL,
  "leverage_cap" numeric DEFAULT '10' NOT NULL,
  "allowed_assets" text[] DEFAULT '{"BTC","ETH","BNB"}' NOT NULL,
  "allowed_venues" text[] DEFAULT '{"hyperliquid"}' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text NOT NULL,
  "updated_reason" text
);
--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_policies_tenant_idx" ON "agent_policies" USING btree ("tenant_id");
