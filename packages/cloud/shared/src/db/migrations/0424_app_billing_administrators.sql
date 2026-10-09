ALTER TABLE app_billing_membership_operations ALTER COLUMN client_registration_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE app_billing_membership_operations ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'member_sync', ADD COLUMN IF NOT EXISTS actor_user_id uuid;
--> statement-breakpoint
ALTER TABLE app_billing_membership_operations ADD CONSTRAINT app_billing_membership_operations_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE app_billing_membership_operations ADD CONSTRAINT app_billing_membership_operations_authority_check CHECK ((operation_kind='member_sync' AND client_registration_id IS NOT NULL AND actor_user_id IS NULL) OR (operation_kind='administrator_change' AND actor_user_id IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_app_billing_membership_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_registration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_client_registrations c WHERE c.id=NEW.client_registration_id AND c.app_id=NEW.app_id AND (c.billing_environment='live')=NEW.livemode) THEN RAISE EXCEPTION 'Membership operation registration scope mismatch'; END IF;
  IF NOT COALESCE(NEW.result->>'appId'=NEW.app_id::text AND NEW.result->>'billingAccountId'=NEW.billing_account_id::text AND NEW.result->>'environment'=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END,false) THEN RAISE EXCEPTION 'Membership result scope mismatch'; END IF;
  RETURN NEW;
END $$;
