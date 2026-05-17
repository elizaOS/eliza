BEGIN;

ALTER TABLE "user_identities"
  ADD COLUMN IF NOT EXISTS "steward_user_id" TEXT;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "steward_user_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_steward_user_id_unique"
  ON "user_identities" ("steward_user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "users_steward_user_id_unique"
  ON "users" ("steward_user_id");

CREATE INDEX IF NOT EXISTS "user_identities_steward_user_id_idx"
  ON "user_identities" ("steward_user_id");

CREATE INDEX IF NOT EXISTS "users_steward_idx"
  ON "users" ("steward_user_id");

COMMIT;
