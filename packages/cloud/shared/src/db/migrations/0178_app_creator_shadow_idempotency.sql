CREATE UNIQUE INDEX IF NOT EXISTS app_earnings_tx_creator_shadow_idempotency_uidx
ON app_earnings_transactions ((metadata ->> 'redeemableLedgerEntryId'))
WHERE (metadata ->> 'redeemableLedgerEntryId') IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS redeemable_earnings_ledger_miniapp_creator_movement_uidx
ON redeemable_earnings_ledger (entry_type, earnings_source, source_id)
WHERE earnings_source = 'miniapp'
  AND entry_type IN ('earning', 'adjustment')
  AND source_id IS NOT NULL
  AND (metadata ->> 'appCreatorShadowVersion') = '1';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS redeemable_earnings_ledger_affiliate_payout_identity_uidx
ON redeemable_earnings_ledger (entry_type, earnings_source, source_id)
WHERE earnings_source = 'affiliate'
  AND entry_type = 'earning'
  AND source_id IS NOT NULL
  AND (metadata ->> 'affiliatePayoutVersion') = '1';
