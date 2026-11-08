-- A cursor chooses which retained legacy entries to try next. It is never
-- evidence that an entry was adopted or authority to remove queue data.
CREATE TABLE "stripe_legacy_adoption_cursors" (
  "source_key" text PRIMARY KEY NOT NULL,
  "cursor_digest" text,
  "revision" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stripe_legacy_adoption_cursor_digest_check"
    CHECK ("cursor_digest" IS NULL OR "cursor_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stripe_legacy_adoption_cursor_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
-- A legacy raw can outlive normal webhook retention. Keep its exact handoff
-- receipt until an owner can prove raw cleanup and old-writer quiescence.
ALTER TABLE "webhook_events"
  ADD COLUMN "delivery_legacy_retained" boolean DEFAULT false NOT NULL;
