-- Durable Dedicated-to-Shared fallback transitions for personal agents. Each
-- withdrawal gets a new generation and a separately scoped Shared journal.
CREATE TABLE IF NOT EXISTS "personal_dedicated_fallbacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "source_agent_id" text NOT NULL,
  "dedicated_agent_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "state" text NOT NULL,
  "reason" text NOT NULL,
  "stop_intent_id" uuid NOT NULL,
  "journal_room_id" text NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "recovered_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_dedicated_fallbacks_state_check"
    CHECK (("state" = 'shared_active' AND "recovered_at" IS NULL)
      OR ("state" = 'recovered' AND "recovered_at" IS NOT NULL)),
  CONSTRAINT "personal_dedicated_fallbacks_reason_check"
    CHECK ("reason" IN ('billing_suspended')),
  CONSTRAINT "personal_dedicated_fallbacks_generation_check"
    CHECK ("generation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_generation_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id", "generation");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_active_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id")
  WHERE "state" = 'shared_active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_journal_unique"
  ON "personal_dedicated_fallbacks" ("journal_room_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_dedicated_idx"
  ON "personal_dedicated_fallbacks" ("dedicated_agent_id");
