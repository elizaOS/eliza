-- #11024: an unverified external-domain attach must no longer be a GLOBAL
-- ownership lock. Replace the global unique on `domain` with a PARTIAL unique
-- (only verified / cloudflare rows are globally exclusive) plus an
-- (organization_id, domain) unique. Different orgs may now each hold a competing
-- UNVERIFIED pending row, so an unproven attach can't squat the namespace and
-- permanently deny the rightful owner. Serving already requires verified+active.
--
-- Safe backfill: the domain column was globally unique before this migration, so
-- (organization_id, domain) is already unique (a subset) and every verified /
-- cloudflare row is already unique on domain — both new indexes build without
-- collision on existing data.
ALTER TABLE "managed_domains" DROP CONSTRAINT IF EXISTS "managed_domains_domain_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "managed_domains_domain_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_domains_domain_exclusive_idx" ON "managed_domains" USING btree ("domain") WHERE "managed_domains"."verified" = true OR "managed_domains"."registrar" = 'cloudflare';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_domains_org_domain_idx" ON "managed_domains" USING btree ("organization_id","domain");
