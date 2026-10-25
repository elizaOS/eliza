-- Mobile recovery names come from a bounded label captured during browser
-- approval, never from an untrusted raw user-agent string.
ALTER TABLE mobile_app_auth_grants
  ADD COLUMN IF NOT EXISTS device_name TEXT;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mobile_app_auth_grants_device_name_check'
      AND conrelid = 'mobile_app_auth_grants'::regclass
  ) THEN
    ALTER TABLE mobile_app_auth_grants
      ADD CONSTRAINT mobile_app_auth_grants_device_name_check
      CHECK (
        device_name IS NULL OR (
          char_length(device_name) BETWEEN 1 AND 80
          AND device_name !~ '[[:cntrl:]]'
        )
      );
  END IF;
END $$;
