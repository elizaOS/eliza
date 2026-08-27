-- Admit independent one-way org/job and actor detach under exact erasure authority.

CREATE OR REPLACE FUNCTION "billing_cancel_authority_immutable"() RETURNS trigger AS $$
DECLARE
  org_detach boolean := false;
  actor_detach boolean := false;
  detach_shape boolean := false;
  authority_request_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    org_detach := OLD."organization_id" IS NOT NULL
      AND OLD."organization_deletion_request_id" IS NULL
      AND NEW."organization_id" IS NULL
      AND NEW."organization_deletion_request_id" IS NOT NULL;
    actor_detach := OLD."requested_by_user_id" IS NOT NULL
      AND OLD."requesting_user_deletion_request_id" IS NULL
      AND NEW."requested_by_user_id" IS NULL
      AND NEW."requesting_user_deletion_request_id" IS NOT NULL;
    detach_shape := (org_detach OR actor_detach)
      AND (org_detach OR (NEW."organization_id" IS NOT DISTINCT FROM OLD."organization_id"
        AND NEW."organization_deletion_request_id"
          IS NOT DISTINCT FROM OLD."organization_deletion_request_id"))
      AND (actor_detach OR (NEW."requested_by_user_id"
          IS NOT DISTINCT FROM OLD."requested_by_user_id"
        AND NEW."requesting_user_deletion_request_id"
          IS NOT DISTINCT FROM OLD."requesting_user_deletion_request_id"));
    IF TG_TABLE_NAME = 'billing_cancel_commands' THEN
      org_detach := org_detach AND OLD."job_id" IS NOT NULL AND NEW."job_id" IS NULL;
      detach_shape := (org_detach OR actor_detach)
        AND (org_detach OR (NEW."organization_id" IS NOT DISTINCT FROM OLD."organization_id"
          AND NEW."organization_deletion_request_id"
            IS NOT DISTINCT FROM OLD."organization_deletion_request_id"
          AND NEW."job_id" IS NOT DISTINCT FROM OLD."job_id"))
        AND (actor_detach OR (NEW."requested_by_user_id"
            IS NOT DISTINCT FROM OLD."requested_by_user_id"
          AND NEW."requesting_user_deletion_request_id"
            IS NOT DISTINCT FROM OLD."requesting_user_deletion_request_id"))
        AND to_jsonb(NEW) - ARRAY['organization_id', 'requested_by_user_id', 'job_id',
          'organization_deletion_request_id', 'requesting_user_deletion_request_id']
          = to_jsonb(OLD) - ARRAY['organization_id', 'requested_by_user_id', 'job_id',
          'organization_deletion_request_id', 'requesting_user_deletion_request_id'];
    ELSE
      detach_shape := detach_shape
        AND to_jsonb(NEW) - ARRAY['organization_id', 'requested_by_user_id',
          'organization_deletion_request_id', 'requesting_user_deletion_request_id']
          = to_jsonb(OLD) - ARRAY['organization_id', 'requested_by_user_id',
          'organization_deletion_request_id', 'requesting_user_deletion_request_id'];
    END IF;
    authority_request_id := COALESCE(
      CASE WHEN org_detach THEN NEW."organization_deletion_request_id" END,
      CASE WHEN actor_detach THEN NEW."requesting_user_deletion_request_id" END
    );
    detach_shape := detach_shape AND (NOT (org_detach AND actor_detach)
      OR NEW."organization_deletion_request_id" = NEW."requesting_user_deletion_request_id");
  END IF;

  IF detach_shape THEN
    PERFORM 1 FROM "account_deletion_requests" request
    JOIN "account_deletion_phase_receipts" phase ON phase."request_id" = request."id"
    JOIN "organizations" organization ON organization."id" = request."organization_id"
    JOIN "users" actor ON actor."id" = request."user_id"
    WHERE request."id" = authority_request_id
      AND request."status" IN ('scheduled', 'processing') AND request."irreversible_at" IS NOT NULL
      AND phase."phase" = 'database_erasure' AND phase."status" IN ('leased', 'calling')
      AND current_setting('eliza.billing_cancel_account_deletion_authority', true)
        = request."id"::text || ':' || phase."id"::text || ':' || phase."lease_generation"::text
      AND (NOT org_detach OR (request."organization_id" = OLD."organization_id"
        AND organization."account_lifecycle_state" = 'deletion_irreversible'
        AND organization."account_deletion_request_id" = request."id"
        AND organization."account_lifecycle_revision" = request."lifecycle_revision"))
      AND (NOT actor_detach OR (request."user_id" = OLD."requested_by_user_id"
        AND actor."organization_id" = request."organization_id"
        AND actor."account_lifecycle_state" = 'deletion_irreversible'
        AND actor."account_deletion_request_id" = request."id"
        AND actor."account_lifecycle_revision" = request."lifecycle_revision"))
    FOR SHARE OF request, phase, organization, actor;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[0],
    MESSAGE = format('%s: authority fields are immutable', TG_ARGV[0]);
END;
$$ LANGUAGE plpgsql;
