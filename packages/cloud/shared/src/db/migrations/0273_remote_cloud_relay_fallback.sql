ALTER TABLE "remote_hosts"
  DROP CONSTRAINT IF EXISTS "remote_hosts_connection_mode_check";

ALTER TABLE "remote_hosts"
  ADD CONSTRAINT "remote_hosts_connection_mode_check"
  CHECK ("connection_mode" IN ('cloud_relay', 'managed_headscale', 'ssh', 'direct'));
