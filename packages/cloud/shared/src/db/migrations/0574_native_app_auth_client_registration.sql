CREATE TABLE IF NOT EXISTS "mobile_app_auth_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "credential_ttl_seconds" integer,
  "android_package_name" text,
  "callback_android_package" text,
  "android_relations" jsonb,
  "android_cert_fingerprints" jsonb,
  "browser_sign_in" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_app_auth_clients_app_id"
  ON "mobile_app_auth_clients" ("app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_app_auth_clients_android_package"
  ON "mobile_app_auth_clients" ("android_package_name")
  WHERE "android_package_name" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_app_auth_clients_redirect_uri"
  ON "mobile_app_auth_clients" ("redirect_uri");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_app_auth_registry_migrations" (
  "environment" text PRIMARY KEY CHECK ("environment" IN ('staging', 'production')),
  "source_digest" text NOT NULL CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  "client_ids" jsonb NOT NULL,
  "client_count" integer NOT NULL CHECK ("client_count" > 0),
  "completed_at" timestamptz NOT NULL DEFAULT now()
);
