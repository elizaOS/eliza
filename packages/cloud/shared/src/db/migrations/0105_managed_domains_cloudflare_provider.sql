-- Add cloudflare as a supported registrar + nameserver provider on
-- managed_domains, plus the two cloudflare-specific identifiers we need
-- to track per registered domain (zone id + registration id).
--
-- This is purely additive on a live table:
--   - Both new columns are nullable (`external`-registrar rows leave them
--     null, cloudflare-registrar rows populate them).
--   - The two enums are extended, not rebuilt — postgres supports
--     ADD VALUE on existing enums in a single statement.
--
-- After this lands, the cloudflare-registrar service can write rows with
-- registrar='cloudflare' / nameserver_mode='cloudflare' and persist the
-- ids needed to talk to the cloudflare API later (renewals, dns updates).

ALTER TYPE "domain_registrar" ADD VALUE IF NOT EXISTS 'cloudflare';
ALTER TYPE "domain_nameserver_mode" ADD VALUE IF NOT EXISTS 'cloudflare';

ALTER TABLE "managed_domains"
  ADD COLUMN IF NOT EXISTS "cloudflare_zone_id" text,
  ADD COLUMN IF NOT EXISTS "cloudflare_registration_id" text;

CREATE INDEX IF NOT EXISTS "managed_domains_cloudflare_zone_idx"
  ON "managed_domains" ("cloudflare_zone_id")
  WHERE "cloudflare_zone_id" IS NOT NULL;
