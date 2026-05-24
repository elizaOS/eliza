ALTER TABLE "agent_server_wallets"
  ADD COLUMN IF NOT EXISTS "sandbox_agent_id" uuid;

DO $$ BEGIN
  ALTER TABLE "agent_server_wallets"
    ADD CONSTRAINT "agent_server_wallets_sandbox_agent_id_agent_sandboxes_id_fk"
    FOREIGN KEY ("sandbox_agent_id")
    REFERENCES "public"."agent_sandboxes"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "agent_server_wallets_sandbox_agent_idx"
  ON "agent_server_wallets" USING btree ("sandbox_agent_id");
