-- Fail closed if legacy active EVM hash casing already represents a double spend.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crypto_payments
    WHERE transaction_hash ~ '^0x[0-9A-Fa-f]+$'
      AND status IN ('pending', 'broadcast', 'confirmed')
    GROUP BY lower(transaction_hash)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'active crypto payments contain duplicate EVM transaction hashes after canonicalization';
  END IF;
END $$;

UPDATE crypto_payments
SET transaction_hash = lower(transaction_hash), updated_at = NOW()
WHERE transaction_hash ~ '^0x[0-9A-Fa-f]+$'
  AND transaction_hash <> lower(transaction_hash);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_payments_active_evm_tx_hash_lower_uidx
  ON crypto_payments (lower(transaction_hash))
  WHERE transaction_hash ~ '^0x[0-9A-Fa-f]+$'
    AND status IN ('pending', 'broadcast', 'confirmed');

CREATE TABLE IF NOT EXISTS app_charge_callback_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key text NOT NULL,
  charge_request_id uuid NOT NULL REFERENCES crypto_payments(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'terminal')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  room_delivered_at timestamptz,
  http_delivered_at timestamptz,
  delivered_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_charge_callback_outbox_delivery_uidx
  ON app_charge_callback_outbox(delivery_key);
CREATE INDEX IF NOT EXISTS app_charge_callback_outbox_due_idx
  ON app_charge_callback_outbox(next_attempt_at, created_at)
  WHERE state IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS crypto_sweep_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES crypto_payments(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'terminal')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  prepared_transaction text,
  sweep_transaction_hash text,
  prepared_metadata jsonb,
  delivered_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT crypto_sweep_outbox_prepared_pair_check
    CHECK (
      (prepared_transaction IS NULL) = (sweep_transaction_hash IS NULL)
      AND (prepared_transaction IS NULL) = (prepared_metadata IS NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS crypto_sweep_outbox_payment_uidx
  ON crypto_sweep_outbox(payment_id);
CREATE INDEX IF NOT EXISTS crypto_sweep_outbox_due_idx
  ON crypto_sweep_outbox(next_attempt_at, created_at)
  WHERE state IN ('pending', 'processing');
