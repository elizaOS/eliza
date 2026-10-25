CREATE TYPE "public"."approval_queue_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."policy_type" AS ENUM('spending-limit', 'approved-addresses', 'auto-approve-threshold', 'time-window', 'rate-limit');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'approved', 'rejected', 'signed', 'broadcast', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"wallet_address" varchar(128) NOT NULL,
	"platform_id" varchar(255),
	"erc8004_token_id" varchar(255),
	"owner_user_id" uuid,
	"wallet_type" varchar(32) DEFAULT 'agent',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_queue" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tx_id" varchar(64) NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"status" "approval_queue_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "encrypted_keys" (
	"agent_id" varchar(64) PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"salt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"type" "policy_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"api_key_hash" text NOT NULL,
	"owner_address" varchar(42),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"status" "transaction_status" NOT NULL,
	"to_address" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"data" text,
	"chain_id" integer NOT NULL,
	"tx_hash" varchar(128),
	"policy_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" integer
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"credential_device_type" varchar(32),
	"credential_backed_up" boolean DEFAULT false,
	"transports" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "user_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255),
	"email_verified" boolean DEFAULT false,
	"name" varchar(255),
	"image" text,
	"wallet_address" varchar(128),
	"steward_wallet_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_tx_id_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_keys" ADD CONSTRAINT "encrypted_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_tenant_id_idx" ON "agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_queue_tx_id_idx" ON "approval_queue" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "approval_queue_status_idx" ON "approval_queue" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_keys_agent_id_idx" ON "encrypted_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "transactions_agent_id_idx" ON "transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_unique" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "authenticators_user_id_idx" ON "authenticators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tenants_unique" ON "user_tenants" USING btree ("user_id","tenant_id");