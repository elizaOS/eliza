ALTER TABLE cloud_password_backup_approvals
  ADD COLUMN device_key text REFERENCES device_grants(key) ON DELETE CASCADE;
