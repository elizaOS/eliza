-- Add missing unique constraint on GroupMember(groupId, userId)
-- This constraint was defined in migration 0005 but may not have been applied to all environments.
-- Required for ON CONFLICT upsert operations in the group member addition flow.

DO $$
BEGIN
    -- Add the unique constraint if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'GroupMember_groupId_userId_key' 
        AND conrelid = '"GroupMember"'::regclass
    ) THEN
        ALTER TABLE "GroupMember" 
        ADD CONSTRAINT "GroupMember_groupId_userId_key" 
        UNIQUE ("groupId", "userId");
        
        RAISE NOTICE 'Added GroupMember_groupId_userId_key constraint';
    ELSE
        RAISE NOTICE 'GroupMember_groupId_userId_key constraint already exists';
    END IF;
END $$;

