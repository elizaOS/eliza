ALTER TABLE "billing_funding_reservations"
  ADD COLUMN "reservation_phase" text NOT NULL DEFAULT 'initial',
  ADD COLUMN "phase_sequence" integer NOT NULL DEFAULT 0,
  ADD COLUMN "parent_reservation_id" uuid,
  ADD COLUMN "root_reservation_id" uuid,
  ADD CONSTRAINT "billing_funding_reservations_parent_tenant_fk"
    FOREIGN KEY (parent_reservation_id, organization_id)
    REFERENCES billing_funding_reservations(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT "billing_funding_reservations_root_tenant_fk"
    FOREIGN KEY (root_reservation_id, organization_id)
    REFERENCES billing_funding_reservations(id, organization_id) ON DELETE RESTRICT,
  ADD CONSTRAINT "billing_funding_reservations_phase_shape_check" CHECK (
    (reservation_phase = 'initial' AND phase_sequence = 0
      AND parent_reservation_id IS NULL AND root_reservation_id IS NULL)
    OR
    (reservation_phase = 'overage' AND phase_sequence > 0
      AND parent_reservation_id IS NOT NULL AND root_reservation_id IS NOT NULL
      AND parent_reservation_id <> id AND root_reservation_id <> id)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_funding_reservations_root_phase_sequence_idx"
  ON "billing_funding_reservations" (organization_id, root_reservation_id, phase_sequence)
  WHERE reservation_phase = 'overage';
--> statement-breakpoint
CREATE FUNCTION "validate_billing_funding_reservation_phase"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reservation_phase = 'initial' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations root
    WHERE root.id = NEW.root_reservation_id
      AND root.organization_id = NEW.organization_id
      AND root.reservation_phase = 'initial'
  ) THEN
    RAISE EXCEPTION 'overage reservation root must be a tenant-scoped initial reservation'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations parent
    WHERE parent.id = NEW.parent_reservation_id
      AND parent.organization_id = NEW.organization_id
      AND (
        (NEW.phase_sequence = 1 AND parent.id = NEW.root_reservation_id
          AND parent.reservation_phase = 'initial')
        OR
        (NEW.phase_sequence > 1 AND parent.root_reservation_id = NEW.root_reservation_id
          AND parent.reservation_phase = 'overage'
          AND parent.phase_sequence = NEW.phase_sequence - 1)
      )
  ) THEN
    RAISE EXCEPTION 'overage reservation parent must be the preceding phase in its root chain'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "billing_funding_reservations_phase_guard"
BEFORE INSERT OR UPDATE OF organization_id, reservation_phase, phase_sequence,
  parent_reservation_id, root_reservation_id
ON "billing_funding_reservations"
FOR EACH ROW EXECUTE FUNCTION "validate_billing_funding_reservation_phase"();
