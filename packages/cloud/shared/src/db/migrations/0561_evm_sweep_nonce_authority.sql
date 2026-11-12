-- Signed sweep bytes retain one durable owner per EVM wallet nonce.
-- Legacy signed rows remain unassigned until their actual signature is decoded.
ALTER TABLE crypto_sweep_outbox
 ADD COLUMN evm_sender text,
 ADD COLUMN evm_chain_id bigint,
 ADD COLUMN evm_nonce bigint,
 ADD COLUMN evm_confirmed_at timestamptz,
 ADD COLUMN evm_confirmed_receipt jsonb;
--> statement-breakpoint
ALTER TABLE crypto_sweep_outbox ADD CONSTRAINT crypto_sweep_outbox_evm_identity_check CHECK (
 num_nonnulls(evm_sender,evm_chain_id,evm_nonce)=0
 OR (num_nonnulls(evm_sender,evm_chain_id,evm_nonce)=3 AND evm_sender ~ '^0x[0-9a-f]{40}$' AND evm_chain_id>0 AND evm_nonce>=0 AND prepared_transaction IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE crypto_sweep_outbox ADD CONSTRAINT crypto_sweep_outbox_evm_confirmation_check CHECK (
 (evm_confirmed_at IS NULL)=(evm_confirmed_receipt IS NULL)
 AND (evm_confirmed_at IS NULL OR (state='delivered' AND evm_sender IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX crypto_sweep_outbox_evm_nonce_uidx ON crypto_sweep_outbox(evm_chain_id,evm_sender,evm_nonce) WHERE evm_sender IS NOT NULL;
--> statement-breakpoint
CREATE INDEX crypto_sweep_outbox_evm_legacy_idx ON crypto_sweep_outbox((prepared_metadata->>'network'),id)
 WHERE evm_sender IS NULL AND prepared_transaction IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION crypto_sweep_evm_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.prepared_transaction IS NOT NULL
   AND (OLD.evm_sender IS NOT NULL OR OLD.prepared_metadata->>'network' IN ('base','bsc'))
   AND OLD.evm_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Unconfirmed EVM sweep authority cannot be erased';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.payload IS DISTINCT FROM OLD.payload
  OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'Crypto sweep intent is immutable';
 END IF;
 IF OLD.prepared_transaction IS NOT NULL
  AND (OLD.evm_sender IS NOT NULL OR OLD.prepared_metadata->>'network' IN ('base','bsc'))
  AND (NEW.prepared_transaction IS DISTINCT FROM OLD.prepared_transaction
   OR NEW.sweep_transaction_hash IS DISTINCT FROM OLD.sweep_transaction_hash
   OR NEW.prepared_metadata IS DISTINCT FROM OLD.prepared_metadata) THEN
   RAISE EXCEPTION 'Prepared EVM sweep authority is immutable';
 END IF;
 IF OLD.evm_sender IS NOT NULL AND (
   NEW.evm_sender IS DISTINCT FROM OLD.evm_sender OR NEW.evm_chain_id IS DISTINCT FROM OLD.evm_chain_id
   OR NEW.evm_nonce IS DISTINCT FROM OLD.evm_nonce
   OR NEW.prepared_transaction IS DISTINCT FROM OLD.prepared_transaction
   OR NEW.sweep_transaction_hash IS DISTINCT FROM OLD.sweep_transaction_hash
   OR NEW.prepared_metadata IS DISTINCT FROM OLD.prepared_metadata
 ) THEN RAISE EXCEPTION 'Prepared EVM sweep authority is immutable'; END IF;
 IF OLD.evm_confirmed_at IS NOT NULL AND (NEW.evm_confirmed_at IS DISTINCT FROM OLD.evm_confirmed_at
   OR NEW.evm_confirmed_receipt IS DISTINCT FROM OLD.evm_confirmed_receipt) THEN
   RAISE EXCEPTION 'Confirmed EVM sweep receipt is immutable';
 END IF;
 IF NEW.evm_confirmed_receipt IS NOT NULL AND (
   NEW.evm_confirmed_receipt->>'transactionHash' IS DISTINCT FROM NEW.sweep_transaction_hash
   OR NEW.evm_confirmed_receipt->>'status' IS DISTINCT FROM 'success'
   OR COALESCE(NEW.evm_confirmed_receipt->>'blockHash','') !~ '^0x[0-9a-fA-F]{64}$'
   OR COALESCE(NEW.evm_confirmed_receipt->>'blockNumber','') !~ '^[0-9]+$'
 ) THEN RAISE EXCEPTION 'EVM sweep receipt does not match prepared transaction'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crypto_sweep_evm_authority_guard BEFORE UPDATE OR DELETE ON crypto_sweep_outbox
 FOR EACH ROW EXECUTE FUNCTION crypto_sweep_evm_authority_guard();

--> statement-breakpoint
CREATE INDEX crypto_sweep_outbox_evm_recovery_due_idx
 ON crypto_sweep_outbox(next_attempt_at,created_at)
 WHERE state IN ('delivered','terminal') AND evm_confirmed_at IS NULL
  AND prepared_transaction IS NOT NULL AND prepared_metadata->>'network' IN ('base','bsc');
