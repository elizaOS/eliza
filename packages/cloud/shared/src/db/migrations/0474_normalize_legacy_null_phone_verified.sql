-- Migration 0051 projected phone_verified NULL for phoneless identities while
-- canonical users stayed false, so strict projection parity rejected otherwise
-- coherent accounts. Normalize only phoneless NULL rows to false; rows with a
-- phone number or a non-null flag are untouched.
UPDATE "user_identities"
SET "phone_verified" = FALSE, "updated_at" = NOW()
WHERE "phone_number" IS NULL AND "phone_verified" IS NULL;
--> statement-breakpoint
UPDATE "users"
SET "phone_verified" = FALSE, "updated_at" = NOW()
WHERE "phone_number" IS NULL AND "phone_verified" IS NULL;
