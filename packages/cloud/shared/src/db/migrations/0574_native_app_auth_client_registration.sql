CREATE TABLE IF NOT EXISTS "mobile_app_auth_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "credential_ttl_seconds" integer,
  "android_package_name" text,
  "android_cert_fingerprints" jsonb,
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
DO $$
DECLARE
  target_app_id uuid;
  matching_count integer;
BEGIN
  SELECT count(*) INTO matching_count
  FROM "apps"
  WHERE "app_url" = 'https://eliza.app'
     OR "allowed_origins" @> '["https://eliza.app/auth/callback"]'::jsonb;

  IF matching_count >= 1 THEN
    SELECT "id" INTO target_app_id
    FROM "apps"
    WHERE "app_url" = 'https://eliza.app'
       OR "allowed_origins" @> '["https://eliza.app/auth/callback"]'::jsonb
    ORDER BY "is_approved" DESC, "is_active" DESC, "created_at" ASC
    LIMIT 1;

    INSERT INTO "mobile_app_auth_clients" (
      "client_id",
      "app_id",
      "redirect_uri",
      "android_package_name",
      "enabled"
    ) VALUES (
      'ai.elizaos.app',
      target_app_id,
      'https://eliza.app/auth/callback',
      'ai.elizaos.app',
      true
    ) ON CONFLICT ("client_id") DO NOTHING;
  END IF;
END $$;
