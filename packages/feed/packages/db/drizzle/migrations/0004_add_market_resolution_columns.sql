-- Add missing resolution columns to Market table
-- These columns may be missing if the database was created before these were added to the schema

DO $$
BEGIN
    -- Add resolutionProofUrl if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Market' AND column_name = 'resolutionProofUrl'
    ) THEN
        ALTER TABLE "Market" ADD COLUMN "resolutionProofUrl" text;
    END IF;

    -- Add resolutionDescription if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Market' AND column_name = 'resolutionDescription'
    ) THEN
        ALTER TABLE "Market" ADD COLUMN "resolutionDescription" text;
    END IF;
END $$;
