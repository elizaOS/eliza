ALTER TABLE calendar_writes
  ADD COLUMN user_id text NOT NULL,
  ADD COLUMN kind text NOT NULL CHECK (kind IN ('create', 'change', 'delete')),
  ADD COLUMN calendar_id text NOT NULL,
  ADD COLUMN if_match text,
  ADD COLUMN request jsonb,
  ADD COLUMN rejection text;
