-- Drop the unused weekly usage-quota table (#22962).
-- Originally created in 0000_last_reavers.sql. The billing audit (#22942) and
-- this removal verified by repo-wide grep at migration time: no application
-- code enforces, produces, resets, or creates usage_quotas rows — the only
-- caller of the subsystem was the read-only GET /api/quotas/usage display
-- route (removed with this change). No inference admission, credit
-- reservation, or model routing path reads it; account-billing-snapshot and
-- active-billing never exposed it. A stored quota with no gate was a ghost
-- entitlement; removal is the product decision recorded in #22962.
--
-- Zero-row guard per the 0149_drop_app_billing precedent (post-merge review
-- on #23812): assert the table holds no rows before dropping so a stray
-- production row — e.g. operator-seeded via console, since the (now removed)
-- UI string "Contact your administrator to set up weekly quotas" was the
-- intended provisioning path — blocks the migration loudly instead of being
-- silently discarded. IF EXISTS buys idempotency; the guard buys data safety.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'usage_quotas'
  ) THEN
    IF (SELECT count(*) FROM "usage_quotas") > 0 THEN
      RAISE EXCEPTION 'usage_quotas holds % row(s); refusing to drop a non-empty table', (SELECT count(*) FROM "usage_quotas");
    END IF;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "usage_quotas";
