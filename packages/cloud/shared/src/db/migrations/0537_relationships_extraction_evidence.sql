-- Cloud schema/journal drift: the relationships drizzle schema declares
-- extraction_evidence (jsonb, nullable), and the plugin-sql runtime core
-- reads and writes it on cloud databases, but no journal entry created it.
-- Databases built by replaying this journal (CI lanes, staging, production)
-- rejected every query that touched the column with errorMissingColumn.
ALTER TABLE "relationships" ADD COLUMN "extraction_evidence" jsonb;
