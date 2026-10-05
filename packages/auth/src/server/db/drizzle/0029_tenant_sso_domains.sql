CREATE TABLE IF NOT EXISTS "tenant_sso_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "domain" varchar(255) NOT NULL,
  "verification_token" varchar(128) NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "sso_required" boolean DEFAULT false NOT NULL,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_sso_domains_tenant_domain_idx"
  ON "tenant_sso_domains" ("tenant_id", "domain");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_sso_domains_tenant_canonical_domain_idx"
  ON "tenant_sso_domains" (
    "tenant_id",
    lower(trim(trailing '.' from "domain"))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_sso_domains_verified_canonical_domain_idx"
  ON "tenant_sso_domains" (
    lower(trim(trailing '.' from "domain"))
  )
  WHERE "status" = 'verified';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_sso_domains_domain_idx"
  ON "tenant_sso_domains" ("domain");
