-- Append-only normalization for phoneless legacy projections: phone_verified NULL → false.
-- Migration 0051 projected NULL when phone_number was absent. Do not touch rows that
-- already have a phone number or a non-null verification flag. Publish only redacted
-- aggregate before/after counts; never log user, provider, session, or phone identifiers.

UPDATE "user_identities"
SET
  "phone_verified" = FALSE,
  "updated_at" = NOW()
WHERE "phone_number" IS NULL
  AND "phone_verified" IS NULL;
--> statement-breakpoint
UPDATE "users"
SET
  "phone_verified" = FALSE,
  "updated_at" = NOW()
WHERE "phone_number" IS NULL
  AND "phone_verified" IS NULL;
--> statement-breakpoint
ALTER TABLE "user_identities"
  DROP CONSTRAINT IF EXISTS "user_identities_phone_verified_requires_number";
--> statement-breakpoint
ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_phone_verified_requires_number"
  CHECK ("phone_verified" IS NOT TRUE OR "phone_number" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_phone_verified_requires_number";
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_verified_requires_number"
  CHECK ("phone_verified" IS NOT TRUE OR "phone_number" IS NOT NULL);
