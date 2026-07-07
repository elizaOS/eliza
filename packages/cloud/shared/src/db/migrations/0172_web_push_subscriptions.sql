-- Web Push subscription store (PWA web-push sender, dossier §3 PR-2).
-- One row per (endpoint, agent). A single installed PWA (one endpoint) can
-- subscribe to multiple agents, so the unique + upsert target is the composite
-- (endpoint, agent_id); keying on endpoint alone would let a second agent's
-- subscribe overwrite the first agent's row. Prune-on-404/410 deletes by
-- endpoint (the device is gone for every agent).

CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"agent_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "web_push_subscriptions_endpoint_agent_uidx" ON "web_push_subscriptions" ("endpoint", "agent_id");
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_user_agent_idx" ON "web_push_subscriptions" ("user_id", "agent_id");
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_user_idx" ON "web_push_subscriptions" ("user_id");
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_endpoint_idx" ON "web_push_subscriptions" ("endpoint");
