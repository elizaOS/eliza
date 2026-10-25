-- Add the `credit_conversion` ledger entry type used by the earnings
-- auto-fund flow (see migration 0070 + packages/lib/services/earnings-auto-fund.ts).
--
-- WHY THIS IS A SEPARATE MIGRATION:
-- Postgres requires that ALTER TYPE ... ADD VALUE be committed before the
-- new value can be used in any transaction. Running this in its own
-- migration guarantees the value is committed before any application
-- code (or future migration) attempts to insert it.

ALTER TYPE "ledger_entry_type" ADD VALUE IF NOT EXISTS 'credit_conversion';
