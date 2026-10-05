-- #208: first-class per-agent budgets spanning providers and operations.
CREATE TABLE "provider_agent_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid,
  "agent_id" varchar(64) NOT NULL,
  "dimension" varchar(16) NOT NULL,
  "window_seconds" integer NOT NULL,
  "max" bigint NOT NULL,
  "currency" varchar(64),
  "auto_freeze" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_agent_budgets_agent_fk"
    FOREIGN KEY ("tenant_id","agent_id") REFERENCES "agents"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "provider_agent_budgets_workspace_fk"
    FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "workspaces"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "provider_agent_budgets_shape_chk" CHECK (
    "dimension" IN ('count','notional') AND
    "window_seconds" BETWEEN 1 AND 2592000 AND
    "max" BETWEEN 0 AND 9007199254740991 AND
    "revision" > 0 AND
    (("dimension" = 'count' AND "currency" IS NULL) OR
     ("dimension" = 'notional' AND "currency" IS NOT NULL AND length("currency") BETWEEN 1 AND 64))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_agent_budgets_identity_idx"
  ON "provider_agent_budgets" (
    "tenant_id", COALESCE("workspace_id"::text, ''), "agent_id", "dimension",
    COALESCE("currency", ''), "window_seconds"
  );
--> statement-breakpoint
CREATE INDEX "provider_agent_budgets_lookup_idx"
  ON "provider_agent_budgets" ("tenant_id","agent_id","enabled","workspace_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_bump_provider_agent_budget_revision()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR
     OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
     OLD.agent_id IS DISTINCT FROM NEW.agent_id OR
     OLD.dimension IS DISTINCT FROM NEW.dimension OR
     OLD.window_seconds IS DISTINCT FROM NEW.window_seconds OR
     OLD.max IS DISTINCT FROM NEW.max OR
     OLD.currency IS DISTINCT FROM NEW.currency OR
     OLD.auto_freeze IS DISTINCT FROM NEW.auto_freeze OR
     OLD.enabled IS DISTINCT FROM NEW.enabled THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  ELSIF NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'provider budget revision changed without configuration mutation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER "provider_agent_budgets_bump_revision"
BEFORE UPDATE ON "provider_agent_budgets"
FOR EACH ROW EXECUTE FUNCTION steward_bump_provider_agent_budget_revision();
--> statement-breakpoint
