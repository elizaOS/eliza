-- Rollback: Remove message type column and enum

-- Drop the index
DROP INDEX IF EXISTS "Message_type_idx";

-- Drop the column
ALTER TABLE "Message" DROP COLUMN IF EXISTS "type";

-- Drop the enum type
DROP TYPE IF EXISTS "message_type";

