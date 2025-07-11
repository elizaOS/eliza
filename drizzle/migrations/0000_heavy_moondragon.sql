CREATE TABLE "erc20" (
	"address" varchar(42) NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"info" json,
	CONSTRAINT "erc20_address_chain_id_pk" PRIMARY KEY("address","chain_id")
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
CREATE INDEX "addressIndex" ON "erc20" USING btree (lower("address"));--> statement-breakpoint
CREATE INDEX "tokenSymbolIndex" ON "erc20" USING btree (lower("symbol"));--> statement-breakpoint
CREATE UNIQUE INDEX "userAddressIndex" ON "levva_user" USING btree (lower("address"));