-- Persist the original checkout request once; existing pending commands remain unreconstructable.
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "checkout_contract" jsonb;
--> statement-breakpoint
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_checkout_contract_shape'
  AND conrelid = 'billing_subscription_commands'::regclass) THEN
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_checkout_contract_shape" CHECK (
  checkout_contract IS NULL OR ((kind = 'checkout' AND jsonb_typeof(checkout_contract) = 'object'
  AND jsonb_typeof(checkout_contract->'payload') = 'object'
  AND jsonb_typeof(checkout_contract->'digest') = 'string'
  AND (checkout_contract->>'digest') ~ '^[a-f0-9]{64}$') IS TRUE)
);
END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_subscription_checkout_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.checkout_contract IS NOT NULL AND NEW.checkout_contract IS DISTINCT FROM OLD.checkout_contract THEN
    RAISE EXCEPTION 'Original checkout contract is immutable';
  END IF;
  IF OLD.checkout_contract IS NULL AND NEW.checkout_contract IS NOT NULL AND OLD.status <> 'PREPARED' THEN
    RAISE EXCEPTION 'Original checkout contract requires prepared command';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS preserve_subscription_checkout_contract ON billing_subscription_commands;
--> statement-breakpoint
CREATE TRIGGER preserve_subscription_checkout_contract BEFORE UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION preserve_subscription_checkout_contract();
