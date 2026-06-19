-- Add quality score and generation depth columns for content integrity tracking.
-- Used by ContentQualityGate to persist validation results and by
-- WorldFactsService/ParodyHeadlineGenerator to filter low-quality records
-- out of generation context.
--
-- qualityScore: nullable — pre-migration records are treated as presumed-OK
-- (WHERE qualityScore IS NULL OR qualityScore >= threshold).
--
-- generationDepth: 0 = human/RSS source, 1 = first-gen LLM output,
-- 2+ = derived from LLM output. Used to structurally prevent recursive
-- amplification by excluding depth >= 2 from prompt context.

ALTER TABLE "WorldFact" ADD COLUMN "qualityScore" double precision;
ALTER TABLE "WorldFact" ADD COLUMN "generationDepth" integer NOT NULL DEFAULT 0;

ALTER TABLE "ParodyHeadline" ADD COLUMN "qualityScore" double precision;
ALTER TABLE "ParodyHeadline" ADD COLUMN "qualityReasons" jsonb;
ALTER TABLE "ParodyHeadline" ADD COLUMN "generationDepth" integer NOT NULL DEFAULT 0;
