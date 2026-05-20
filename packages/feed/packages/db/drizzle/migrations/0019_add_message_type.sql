-- Add message type enum and column to Message table
-- This allows distinguishing between user messages and system messages (invites, joins, etc.)

-- Create the enum type if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_type') THEN
        CREATE TYPE "message_type" AS ENUM ('user', 'system');
        RAISE NOTICE 'Created message_type enum';
    ELSE
        RAISE NOTICE 'message_type enum already exists';
    END IF;
END $$;

-- Add the type column to Message table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Message' AND column_name = 'type'
    ) THEN
        ALTER TABLE "Message" ADD COLUMN "type" "message_type" NOT NULL DEFAULT 'user';
        RAISE NOTICE 'Added type column to Message table';
    ELSE
        RAISE NOTICE 'type column already exists on Message table';
    END IF;
END $$;

-- Update existing system messages (where senderId = 'system') to have type = 'system'
UPDATE "Message" SET "type" = 'system' WHERE "senderId" = 'system';

-- Add index for type column
CREATE INDEX IF NOT EXISTS "Message_type_idx" ON "Message" ("type");

