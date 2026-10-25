-- Index for hot list queries: conversation message timeline ordered DESC by sequence_number.
-- Existing conv_messages_sequence_idx is ASC and is not used by ORDER BY ... DESC scans.
CREATE INDEX IF NOT EXISTS "conv_messages_seq_desc_idx"
  ON "conversation_messages" USING btree ("conversation_id", "sequence_number" DESC);
