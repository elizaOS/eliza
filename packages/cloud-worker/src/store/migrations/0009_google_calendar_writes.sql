ALTER TABLE calendar_writes
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES accounts (key),
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS calendar_id text,
  ADD COLUMN IF NOT EXISTS if_match text,
  ADD COLUMN IF NOT EXISTS request jsonb,
  ADD COLUMN IF NOT EXISTS rejection text;

ALTER TABLE calendar_writes
  ADD CONSTRAINT calendar_writes_dispatch_fields CHECK (
    user_id IS NOT NULL AND kind IS NOT NULL AND kind IN ('create', 'change', 'delete') AND calendar_id IS NOT NULL
  ) NOT VALID;
