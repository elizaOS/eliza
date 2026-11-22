ALTER TABLE cloud_password_backup_approvals
  ALTER COLUMN session_key DROP NOT NULL,
  ADD COLUMN native_google_subject text,
  ADD COLUMN native_google_presenter text,
  ADD CONSTRAINT cloud_password_backup_authority CHECK (
    (session_key IS NOT NULL AND native_google_subject IS NULL AND native_google_presenter IS NULL) OR
    (session_key IS NULL AND device_key IS NOT NULL AND native_google_subject IS NOT NULL AND native_google_presenter IS NOT NULL)
  );
