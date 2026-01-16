-- Add NFT gating columns to Chat table
-- Allows group chats to require specific ERC721 NFT ownership for access

DO $$
BEGIN
    -- Add requiredNftContractAddress if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Chat' AND column_name = 'requiredNftContractAddress'
    ) THEN
        ALTER TABLE "Chat" ADD COLUMN "requiredNftContractAddress" text;
    END IF;

    -- Add requiredNftTokenId if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Chat' AND column_name = 'requiredNftTokenId'
    ) THEN
        ALTER TABLE "Chat" ADD COLUMN "requiredNftTokenId" integer;
    END IF;

    -- Add requiredNftChainId if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Chat' AND column_name = 'requiredNftChainId'
    ) THEN
        ALTER TABLE "Chat" ADD COLUMN "requiredNftChainId" integer;
    END IF;

    -- Add nftGated if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Chat' AND column_name = 'nftGated'
    ) THEN
        ALTER TABLE "Chat" ADD COLUMN "nftGated" boolean DEFAULT false NOT NULL;
    END IF;
END $$;

-- Create indexes for NFT gating queries
CREATE INDEX IF NOT EXISTS "Chat_nftGated_idx" ON "Chat" USING btree ("nftGated");
CREATE INDEX IF NOT EXISTS "Chat_requiredNftContractAddress_idx" ON "Chat" USING btree ("requiredNftContractAddress");

-- Set nftGated = true for existing chats with NFT requirements
UPDATE "Chat" 
SET "nftGated" = true 
WHERE "requiredNftContractAddress" IS NOT NULL;

