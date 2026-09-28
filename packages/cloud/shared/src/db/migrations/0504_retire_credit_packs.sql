-- #22963: fixed credit packs are retired. Pay-as-you-go top-ups are any
-- whole-cent amount from $5 to $1,000, and UI quick picks ($10/$25/$50/$100)
-- are plain amounts of that checkout with no bonus credit. Pack rows stay for
-- historical checkout orders, ledger rows and receipts; they are only
-- deactivated so no surface can offer or sell them again.
UPDATE "credit_packs"
SET "is_active" = false, "updated_at" = now()
WHERE "is_active" = true;
