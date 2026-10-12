-- Relationship extraction evidence: the plugin-sql relationships schema has
-- extraction_evidence (relationshipTable.extractionEvidence), and the agent
-- write-back route inserts through that shared table. Cloud databases get
-- their columns only from this migration ledger, so without this column every
-- relationship write-back fails with 42703.
-- Additive: existing relationships keep NULL (no recorded evidence).
ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "extraction_evidence" jsonb;
