CREATE TABLE IF NOT EXISTS "ad_attribution_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "campaign_id" uuid NOT NULL,
  "creative_id" uuid,
  "app_id" uuid,
  "destination_url" text NOT NULL,
  "utm_url" text NOT NULL,
  "utm_source" text NOT NULL,
  "utm_medium" text NOT NULL,
  "utm_campaign" text NOT NULL,
  "utm_content" text,
  "utm_term" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ad_attribution_links_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "ad_attribution_links_campaign_id_ad_campaigns_id_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  CONSTRAINT "ad_attribution_links_creative_id_ad_creatives_id_fk"
    FOREIGN KEY ("creative_id") REFERENCES "ad_creatives"("id") ON DELETE set null,
  CONSTRAINT "ad_attribution_links_app_id_apps_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE set null
);

CREATE INDEX IF NOT EXISTS "ad_attribution_links_org_idx"
  ON "ad_attribution_links" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_attribution_links_campaign_idx"
  ON "ad_attribution_links" ("campaign_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ad_attribution_links_deterministic_idx"
  ON "ad_attribution_links" (
    "campaign_id",
    "creative_id",
    "destination_url",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term"
  ) NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS "ad_conversion_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "campaign_id" uuid NOT NULL,
  "app_id" uuid,
  "creative_id" uuid,
  "event_type" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "value" numeric(12, 2),
  "currency" text DEFAULT 'USD' NOT NULL,
  "source_url" text,
  "referrer" text,
  "user_agent" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ad_conversion_events_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade,
  CONSTRAINT "ad_conversion_events_campaign_id_ad_campaigns_id_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE cascade,
  CONSTRAINT "ad_conversion_events_app_id_apps_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE set null,
  CONSTRAINT "ad_conversion_events_creative_id_ad_creatives_id_fk"
    FOREIGN KEY ("creative_id") REFERENCES "ad_creatives"("id") ON DELETE set null
);

CREATE INDEX IF NOT EXISTS "ad_conversion_events_org_idx"
  ON "ad_conversion_events" ("organization_id");
CREATE INDEX IF NOT EXISTS "ad_conversion_events_campaign_idx"
  ON "ad_conversion_events" ("campaign_id");
CREATE INDEX IF NOT EXISTS "ad_conversion_events_app_idx"
  ON "ad_conversion_events" ("app_id");
CREATE INDEX IF NOT EXISTS "ad_conversion_events_occurred_at_idx"
  ON "ad_conversion_events" ("occurred_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ad_conversion_events_dedupe_idx"
  ON "ad_conversion_events" ("campaign_id", "event_type", "dedupe_key");
