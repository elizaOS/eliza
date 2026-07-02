CREATE TABLE IF NOT EXISTS "ad_audience_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "created_by_user_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "targeting" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ad_audience_segments_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "ad_audience_segments_created_by_user_id_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null
);

CREATE INDEX IF NOT EXISTS "ad_audience_segments_organization_idx"
  ON "ad_audience_segments" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_audience_segments_created_by_idx"
  ON "ad_audience_segments" ("created_by_user_id");
CREATE INDEX IF NOT EXISTS "ad_audience_segments_created_at_idx"
  ON "ad_audience_segments" ("created_at");
