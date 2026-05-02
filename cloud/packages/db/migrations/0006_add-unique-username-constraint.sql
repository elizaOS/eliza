-- Custom SQL migration file, put your code below! --
-- Add unique constraint on username column for URL routing (/chat/@username)

-- Create index for faster username lookups
CREATE INDEX IF NOT EXISTS "user_characters_username_idx" ON "user_characters" USING btree ("username");

-- Add unique constraint (allows NULLs - only non-NULL values must be unique)
ALTER TABLE "user_characters" ADD CONSTRAINT "user_characters_username_unique" UNIQUE("username");
