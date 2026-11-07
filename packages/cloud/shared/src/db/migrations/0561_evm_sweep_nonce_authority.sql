-- Signed sweep bytes retain one durable owner per EVM wallet nonce.
-- Legacy signed rows remain unassigned until their actual signature is decoded.
ALTER TABLE crypto_sweep_outbox
 ADD COLUMN evm_sender text,
 ADD COLUMN evm_chain_id bigint,
 ADD COLUMN evm_nonce bigint;
--> statement-breakpoint
ALTER TABLE crypto_sweep_outbox ADD CONSTRAINT crypto_sweep_outbox_evm_identity_check CHECK (
 num_nonnulls(evm_sender,evm_chain_id,evm_nonce)=0
 OR (num_nonnulls(evm_sender,evm_chain_id,evm_nonce)=3 AND evm_sender ~ '^0x[0-9a-f]{40}$' AND evm_chain_id>0 AND evm_nonce>=0 AND prepared_transaction IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX crypto_sweep_outbox_evm_nonce_uidx ON crypto_sweep_outbox(evm_chain_id,evm_sender,evm_nonce) WHERE evm_sender IS NOT NULL;
--> statement-breakpoint
CREATE INDEX crypto_sweep_outbox_evm_legacy_idx ON crypto_sweep_outbox((prepared_metadata->>'network'),id)
 WHERE evm_sender IS NULL AND prepared_transaction IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION crypto_sweep_evm_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.evm_sender IS NOT NULL AND (
   NEW.evm_sender IS DISTINCT FROM OLD.evm_sender OR NEW.evm_chain_id IS DISTINCT FROM OLD.evm_chain_id
   OR NEW.evm_nonce IS DISTINCT FROM OLD.evm_nonce
   OR NEW.prepared_transaction IS DISTINCT FROM OLD.prepared_transaction
   OR NEW.sweep_transaction_hash IS DISTINCT FROM OLD.sweep_transaction_hash
   OR NEW.prepared_metadata IS DISTINCT FROM OLD.prepared_metadata
 ) THEN RAISE EXCEPTION 'Prepared EVM sweep authority is immutable'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER crypto_sweep_evm_authority_guard BEFORE UPDATE ON crypto_sweep_outbox
 FOR EACH ROW EXECUTE FUNCTION crypto_sweep_evm_authority_guard();
