DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'condition-set'
      AND enumtypid = 'policy_type'::regtype
  ) THEN
    ALTER TYPE "policy_type" ADD VALUE 'condition-set';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "condition_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "owner_id" varchar(255),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "condition_sets_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "condition_set_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "condition_set_id" uuid NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "value" text NOT NULL,
  "label" varchar(255),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "condition_set_items_condition_set_id_condition_sets_id_fk"
    FOREIGN KEY ("condition_set_id") REFERENCES "condition_sets"("id") ON DELETE cascade,
  CONSTRAINT "condition_set_items_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "condition_sets_tenant_idx"
  ON "condition_sets" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "condition_sets_tenant_name_idx"
  ON "condition_sets" ("tenant_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "condition_set_items_set_idx"
  ON "condition_set_items" ("condition_set_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "condition_set_items_tenant_idx"
  ON "condition_set_items" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "condition_set_items_set_value_idx"
  ON "condition_set_items" ("condition_set_id", "value");
