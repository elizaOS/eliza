-- Personal Shared agents use canonical `personal:<uuid>` identifiers, while
-- legacy dedicated agents retain plain UUID identifiers.
ALTER TABLE "twilio_inbound_calls"
ALTER COLUMN "agent_id" TYPE text USING "agent_id"::text;
