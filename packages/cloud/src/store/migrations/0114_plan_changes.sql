ALTER TABLE quotes RENAME COLUMN id TO key;
ALTER TABLE quotes
  ADD COLUMN state jsonb NOT NULL,
  ADD COLUMN revision bigint NOT NULL,
  ADD COLUMN command_id text UNIQUE,
  ADD COLUMN invoice_id text,
  ADD COLUMN created_at bigint NOT NULL,
  ADD COLUMN updated_at bigint NOT NULL;
CREATE INDEX quotes_live_commands ON quotes ((state->>'phase'), created_at) WHERE command_id IS NOT NULL;
