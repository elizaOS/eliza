ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "stewardId" text;
CREATE UNIQUE INDEX IF NOT EXISTS "User_stewardId_key" ON "User" ("stewardId");
