#!/usr/bin/env bash
# Applies and verifies the trusted-transport identity provenance constraint.
set -euo pipefail

database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
test -n "$database_url"

psql "$database_url" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.identity_links') IS NULL THEN
    RAISE EXCEPTION 'identity_links table is missing';
  END IF;
END $$;
ALTER TABLE identity_links
  DROP CONSTRAINT IF EXISTS identity_links_source_check;
ALTER TABLE identity_links
  ADD CONSTRAINT identity_links_source_check
  CHECK (source IN ('oauth', 'manual', 'wallet', 'transport'));
COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'identity_links'::regclass
      AND conname = 'identity_links_source_check'
      AND pg_get_constraintdef(oid) LIKE '%transport%'
  ) THEN
    RAISE EXCEPTION 'transport source constraint verification failed';
  END IF;
END $$;
SELECT 'identity_links transport source enabled' AS result;
SQL
