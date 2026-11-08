-- Preserve the first external dispatch independently of mutable audit timestamps.
-- Historical started/ambiguous orders deliberately remain NULL: their original
-- dispatch cannot be recovered from updated_at, so they may only reconcile reads.
ALTER TABLE "stripe_checkout_orders"
  ADD COLUMN IF NOT EXISTS "provider_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stripe_checkout_provider_start_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'stripe checkout first dispatch must be recorded by its start transition';
    END IF;
  ELSIF OLD.provider_started_at IS NOT NULL THEN
    IF NEW.provider_started_at IS DISTINCT FROM OLD.provider_started_at THEN
      RAISE EXCEPTION 'stripe checkout first dispatch is immutable';
    END IF;
  ELSIF NEW.provider_started_at IS NOT NULL AND NOT (
    OLD.status = 'quoted' AND NEW.status = 'provider_started'
  ) THEN
    RAISE EXCEPTION 'stripe checkout legacy dispatch time cannot be fabricated';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stripe_checkout_provider_start_guard ON stripe_checkout_orders;
--> statement-breakpoint
CREATE TRIGGER stripe_checkout_provider_start_guard
  BEFORE INSERT OR UPDATE ON stripe_checkout_orders
  FOR EACH ROW EXECUTE FUNCTION stripe_checkout_provider_start_guard();
