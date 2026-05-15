ALTER TABLE "referral_codes"
ADD COLUMN IF NOT EXISTS "parent_referral_id" uuid;

ALTER TABLE "referral_signups"
ADD COLUMN IF NOT EXISTS "app_owner_id" uuid;

ALTER TABLE "referral_signups"
ADD COLUMN IF NOT EXISTS "creator_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referral_signups_app_owner_id_users_id_fk'
  ) THEN
    ALTER TABLE "referral_signups"
    ADD CONSTRAINT "referral_signups_app_owner_id_users_id_fk"
    FOREIGN KEY ("app_owner_id")
    REFERENCES "public"."users"("id")
    ON DELETE set null
    ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'referral_signups_creator_id_users_id_fk'
  ) THEN
    ALTER TABLE "referral_signups"
    ADD CONSTRAINT "referral_signups_creator_id_users_id_fk"
    FOREIGN KEY ("creator_id")
    REFERENCES "public"."users"("id")
    ON DELETE set null
    ON UPDATE no action;
  END IF;
END $$;
