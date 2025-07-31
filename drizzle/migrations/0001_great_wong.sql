CREATE TYPE "public"."key_type" AS ENUM('api_key');--> statement-breakpoint
CREATE TABLE "levva_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" varchar(66) NOT NULL,
	"type" "key_type" NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "levva_user" ADD COLUMN "creator_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "levva_secrets_hash_index" ON "levva_secrets" USING btree ("hash");--> statement-breakpoint
ALTER TABLE "levva_user" ADD CONSTRAINT "levva_user_creator_id_levva_secrets_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."levva_secrets"("id") ON DELETE no action ON UPDATE no action;