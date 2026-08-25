-- Drop the unused weekly usage-quota table (#22962).
-- Originally created in 0000_last_reavers.sql. The billing audit (#22942) and
-- this removal verified by repo-wide grep at migration time: no application
-- code enforces, produces, resets, or creates usage_quotas rows — the only
-- caller of the subsystem was the read-only GET /api/quotas/usage display
-- route (removed with this change). No inference admission, credit
-- reservation, or model routing path reads it; account-billing-snapshot and
-- active-billing never exposed it. A stored quota with no gate was a ghost
-- entitlement; removal is the product decision recorded in #22962.
DROP TABLE IF EXISTS "usage_quotas";
