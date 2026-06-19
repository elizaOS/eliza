-- Migration: Add WhatsApp identity columns to users table
-- Supports WhatsApp authentication for Eliza App
-- Generated via: npx drizzle-kit generate --custom --name=add_whatsapp_identity_columns

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_name" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_whatsapp_id_unique'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_whatsapp_id_unique" UNIQUE ("whatsapp_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_whatsapp_id_idx"
  ON "users" ("whatsapp_id")
  WHERE "whatsapp_id" IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'whatsapp'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'phone_provider')
  ) THEN
    ALTER TYPE phone_provider ADD VALUE 'whatsapp';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'whatsapp'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'phone_type')
  ) THEN
    ALTER TYPE phone_type ADD VALUE 'whatsapp';
  END IF;
END $$;
