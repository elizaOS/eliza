CREATE TABLE IF NOT EXISTS "org_rate_limit_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"completions_rpm" integer,
	"embeddings_rpm" integer,
	"standard_rpm" integer,
	"strict_rpm" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_rate_limit_overrides" ADD CONSTRAINT "org_rate_limit_overrides_organization_id_unique" UNIQUE("organization_id");
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_rate_limit_overrides" ADD CONSTRAINT "org_rate_limit_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_rate_limit_overrides" ADD CONSTRAINT "chk_rpm_positive" CHECK (
   (completions_rpm IS NULL OR completions_rpm > 0) AND
   (embeddings_rpm IS NULL OR embeddings_rpm > 0) AND
   (standard_rpm IS NULL OR standard_rpm > 0) AND
   (strict_rpm IS NULL OR strict_rpm > 0)
 );
EXCEPTION
 WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_transactions_org_type" ON "credit_transactions" ("organization_id", "type");
