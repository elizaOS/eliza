-- Makes exact server-written receipts authoritative for personal Dedicated adoption and cutover.

CREATE TABLE "personal_dedicated_upgrade_authorities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "source_agent_id" text NOT NULL,
  "dedicated_agent_id" uuid NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "bound_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cutover_token" text,
  "shared_message_count" integer,
  "shared_scheduled_task_count" integer,
  "shared_todo_count" integer,
  "shared_todo_mutation_count" integer,
  "shared_todo_digest" text,
  "cutover_activated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_dedicated_upgrade_authorities_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_dedicated_upgrade_authorities_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk"
    FOREIGN KEY ("dedicated_agent_id") REFERENCES "public"."agent_sandboxes"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_dedicated_upgrade_authorities_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "personal_dedicated_upgrade_authorities_cutover_check" CHECK ((
    "cutover_token" IS NULL
    AND "shared_message_count" IS NULL
    AND "shared_scheduled_task_count" IS NULL
    AND "shared_todo_count" IS NULL
    AND "shared_todo_mutation_count" IS NULL
    AND "shared_todo_digest" IS NULL
    AND "cutover_activated_at" IS NULL
  ) OR (
    "cutover_token" IS NOT NULL
    AND "shared_message_count" >= 0
    AND "shared_scheduled_task_count" >= 0
    AND "shared_todo_count" >= 0
    AND "shared_todo_mutation_count" >= 0
    AND "shared_todo_digest" ~ '^[a-f0-9]{64}$'
    AND "cutover_activated_at" IS NOT NULL
  ))
);

CREATE UNIQUE INDEX "personal_dedicated_upgrade_authorities_source_unique"
  ON "personal_dedicated_upgrade_authorities" USING btree
  ("organization_id", "user_id", "source_agent_id");
CREATE UNIQUE INDEX "personal_dedicated_upgrade_authorities_target_unique"
  ON "personal_dedicated_upgrade_authorities" USING btree ("dedicated_agent_id");

-- JSON markers written before this receipt existed cannot be distinguished
-- from caller-forged values. They deliberately remain unblessed: application
-- reads quarantine their presence, and the next ordinary profile edit purges
-- them unless an exact receipt independently verifies the row.
