CREATE INDEX IF NOT EXISTS "Position_status_resolvedAt_idx"
ON "Position" ("status", "resolvedAt");
