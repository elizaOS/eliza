-- D-4: Audit log retention.
--
-- Adds `expires_at` to secret_audit_log with a 7-year default for
-- SOC2 security-relevant audit. The purge job at
-- packages/cloud/api/src/jobs/audit-log-purge.ts removes rows where
-- expires_at < now().

ALTER TABLE secret_audit_log
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL
    DEFAULT (NOW() + INTERVAL '7 years');

CREATE INDEX IF NOT EXISTS secret_audit_log_expires_at_idx ON secret_audit_log(expires_at);
