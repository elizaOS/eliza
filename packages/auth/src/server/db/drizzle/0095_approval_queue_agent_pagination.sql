-- Bound agent-scoped approval queue scans before the serialized-precision
-- keyset sort. The requested_at column remains in the index even though the
-- route deliberately truncates it to milliseconds for its JavaScript cursor;
-- PostgreSQL can use the (agent_id, status) prefix to isolate the small queue
-- before sorting, and raw requested_at keeps the index useful to other readers.
CREATE INDEX IF NOT EXISTS "approval_queue_agent_status_requested_idx"
  ON "approval_queue" ("agent_id", "status", "requested_at" DESC, "id" DESC);
