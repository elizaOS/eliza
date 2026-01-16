-- Add lastNftRevalidatedAt timestamp to Chat table
-- Used by the NFT revalidation cron job to track which chats have been
-- processed recently, enabling true round-robin processing instead of
-- always processing the same oldest chats.

DO $$
BEGIN
    -- Add lastNftRevalidatedAt if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Chat' AND column_name = 'lastNftRevalidatedAt'
    ) THEN
        ALTER TABLE "Chat" ADD COLUMN "lastNftRevalidatedAt" timestamp;
    END IF;
END $$;

-- Create index for efficient ordering in the cron job query
CREATE INDEX IF NOT EXISTS "Chat_lastNftRevalidatedAt_idx" ON "Chat" USING btree ("lastNftRevalidatedAt");

-- Create composite index for NFT-gated chat revalidation queries
CREATE INDEX IF NOT EXISTS "Chat_nftGated_lastNftRevalidatedAt_idx" ON "Chat" USING btree ("nftGated", "lastNftRevalidatedAt");
