-- Attach tenant admission and append-only guards to both receipt tables.

CREATE TRIGGER "billing_cancel_commands_actor_tenant_guard"
  BEFORE INSERT ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_actor_tenant_guard"(
    'billing_cancel_commands_requesting_user_tenant_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_job_tenant_guard"
  BEFORE INSERT ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_command_job_tenant_guard"();
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_authority_immutable"
  BEFORE UPDATE OR DELETE ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_commands_authority_immutable'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_truncate_guard"
  BEFORE TRUNCATE ON "billing_cancel_commands"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_commands_truncate_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_actor_tenant_guard"
  BEFORE INSERT ON "billing_cancel_command_keys"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_actor_tenant_guard"(
    'billing_cancel_command_keys_requesting_user_tenant_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_authority_immutable"
  BEFORE UPDATE OR DELETE ON "billing_cancel_command_keys"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_command_keys_authority_immutable'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_truncate_guard"
  BEFORE TRUNCATE ON "billing_cancel_command_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_command_keys_truncate_guard'
  );
