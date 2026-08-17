-- Lifecycle is globally sealed until reconciliation activates durable mode.
CREATE OR REPLACE FUNCTION "guard_active_auto_top_up_organization_deletion"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutover_mode text;
BEGIN
  SELECT "mode" INTO cutover_mode FROM "auto_top_up_control"
  WHERE "singleton" = true FOR SHARE;
  IF cutover_mode IS DISTINCT FROM 'durable' THEN
    RAISE EXCEPTION 'organization deletion blocked while auto-top-up cutover is paused'
      USING ERRCODE = '23503', CONSTRAINT = 'auto_top_up_cutover_paused';
  END IF;
  IF EXISTS (SELECT 1 FROM "auto_top_up_attempts" WHERE "organization_id" = OLD."id"
      AND "status" IN ('claimed','payment_pending','payment_succeeded','manual_review'))
    OR EXISTS (SELECT 1 FROM "auto_top_up_legacy_payment_quarantine"
      WHERE "organization_id" = OLD."id" AND "status" IN ('unresolved','manual_review')) THEN
    RAISE EXCEPTION 'organization has unresolved auto-top-up work'
      USING ERRCODE = '23503', CONSTRAINT = 'auto_top_up_unresolved_work';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS "organizations_active_auto_top_up_delete_guard" ON "organizations";
CREATE TRIGGER "organizations_active_auto_top_up_delete_guard" BEFORE DELETE ON "organizations"
FOR EACH ROW EXECUTE FUNCTION "guard_active_auto_top_up_organization_deletion"();

CREATE OR REPLACE FUNCTION "guard_last_user_auto_top_up_vacate"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_organization_id uuid := OLD."organization_id";
  remaining_users bigint;
  locked_credit_balance numeric;
  cutover_mode text;
BEGIN
  IF old_organization_id IS NULL OR (TG_OP = 'UPDATE'
      AND NEW."organization_id" IS NOT DISTINCT FROM old_organization_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT "credit_balance" INTO locked_credit_balance FROM "organizations"
  WHERE "id" = old_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT count(*) INTO remaining_users FROM "users"
  WHERE "organization_id" = old_organization_id AND "id" <> OLD."id";
  IF remaining_users = 0 THEN
    SELECT "mode" INTO cutover_mode FROM "auto_top_up_control"
    WHERE "singleton" = true FOR SHARE;
    IF cutover_mode IS DISTINCT FROM 'durable' THEN
      RAISE EXCEPTION 'last user cannot leave while auto-top-up cutover is paused'
        USING ERRCODE = '23503', CONSTRAINT = 'auto_top_up_cutover_paused';
    END IF;
    IF EXISTS (SELECT 1 FROM "auto_top_up_attempts" WHERE "organization_id" = old_organization_id
        AND "status" IN ('claimed','payment_pending','payment_succeeded','manual_review'))
      OR EXISTS (SELECT 1 FROM "auto_top_up_legacy_payment_quarantine"
        WHERE "organization_id" = old_organization_id AND "status" IN ('unresolved','manual_review')) THEN
      RAISE EXCEPTION 'last user cannot leave unresolved auto-top-up work'
        USING ERRCODE = '23503', CONSTRAINT = 'auto_top_up_unresolved_work';
    END IF;
    IF locked_credit_balance IS DISTINCT FROM 0::numeric THEN
      RAISE EXCEPTION 'last user cannot leave an organization with credits'
        USING ERRCODE = '23514', CONSTRAINT = 'organization_nonzero_credit_balance';
    END IF;
    UPDATE "organizations" SET "auto_top_up_enabled" = false WHERE "id" = old_organization_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "users_active_auto_top_up_vacate_guard" ON "users";
CREATE TRIGGER "users_active_auto_top_up_vacate_guard"
BEFORE UPDATE OF "organization_id" OR DELETE ON "users"
FOR EACH ROW EXECUTE FUNCTION "guard_last_user_auto_top_up_vacate"();
