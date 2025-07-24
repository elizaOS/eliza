CREATE TYPE "public"."asset_type" AS ENUM('native', 'erc20');--> statement-breakpoint
CREATE TABLE "balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" varchar(42) NOT NULL,
	"chain_id" integer NOT NULL,
	"token" varchar(42) NOT NULL,
	"amount" numeric NOT NULL,
	"value" numeric NOT NULL,
	"type" "asset_type" NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "balances_address_chain_id_token_unique" UNIQUE("address","chain_id","token")
);
--> statement-breakpoint
CREATE TABLE "erc20" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" varchar(42) NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"info" json,
	CONSTRAINT "erc20_address_chain_id_symbol_unique" UNIQUE("address","chain_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "levva_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	CONSTRAINT "levva_user_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "latest_news" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"link" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "balanceAddressIndex" ON "balances" USING btree ("address");--> statement-breakpoint
CREATE INDEX "balanceChainIdIndex" ON "balances" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "balanceTokenIndex" ON "balances" USING btree ("token");--> statement-breakpoint
CREATE INDEX "addressIndex" ON "erc20" USING btree ("address");--> statement-breakpoint
CREATE INDEX "tokenSymbolIndex" ON "erc20" USING btree (lower("symbol"));--> statement-breakpoint
CREATE INDEX "chainIdIndex" ON "erc20" USING btree ("chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "userAddressIndex" ON "levva_user" USING btree (lower("address"));