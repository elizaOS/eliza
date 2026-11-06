-- The organization owns an app. Removing its creator clears audit metadata;
-- it must not delete the app or the grants of other people using that app.
ALTER TABLE "apps" DROP CONSTRAINT "apps_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "created_by_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Billing registration belongs to the same app and organization, not its creator.
ALTER TABLE "app_billing_registrations" DROP CONSTRAINT "app_billing_registrations_owner_fk";
--> statement-breakpoint
DROP INDEX "apps_billing_owner_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "apps_billing_owner_idx" ON "apps" ("id", "organization_id");
--> statement-breakpoint
ALTER TABLE "app_billing_registrations" ADD CONSTRAINT "app_billing_registrations_owner_fk"
  FOREIGN KEY ("app_id", "owner_organization_id") REFERENCES "apps"("id", "organization_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "app_billing_registrations" ALTER COLUMN "registered_by_user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_registration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.registered_by_user_id IS NOT NULL AND NEW.registered_by_user_id IS NULL
     AND (to_jsonb(NEW) - 'registered_by_user_id') = (to_jsonb(OLD) - 'registered_by_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'App billing identity is immutable; transfer and merchant policy are unconfigured';
END $$;
--> statement-breakpoint
DROP TRIGGER "app_billing_registrations_immutable" ON "app_billing_registrations";
--> statement-breakpoint
CREATE TRIGGER "app_billing_registrations_immutable" BEFORE UPDATE ON "app_billing_registrations"
  FOR EACH ROW EXECUTE FUNCTION guard_app_billing_registration_identity();
--> statement-breakpoint
-- Historical audit references may already outlive their users in older schemas.
UPDATE "app_billing_registrations" AS registration SET "registered_by_user_id" = NULL
  WHERE registration."registered_by_user_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = registration."registered_by_user_id");
--> statement-breakpoint
ALTER TABLE "app_billing_registrations" ADD CONSTRAINT "app_billing_registrations_registered_by_user_id_users_id_fk"
  FOREIGN KEY ("registered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
