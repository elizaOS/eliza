ALTER TABLE subscription_commands DROP CONSTRAINT subscription_commands_status_check;
ALTER TABLE subscription_commands DROP CONSTRAINT subscription_commands_expected_revision_check;
ALTER TABLE subscription_commands
  ADD CONSTRAINT subscription_commands_status_check CHECK (status IN ('quoted', 'dispatched', 'unknown', 'awaiting_payment', 'succeeded', 'rejected')),
  ADD CONSTRAINT subscription_commands_expected_revision_check CHECK (expected_revision >= 0);
