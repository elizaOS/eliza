ALTER TABLE speech_windows ADD COLUMN started_at bigint;
ALTER TABLE speech_windows ADD COLUMN settlement_basis text
  CHECK (settlement_basis IN ('submitted_counter_provider_unconfirmed', 'retirement'));
ALTER TABLE speech_windows ADD COLUMN submitted_pcm_bytes bigint CHECK (submitted_pcm_bytes >= 0);
ALTER TABLE speech_windows ADD COLUMN submitted_tts_chars bigint CHECK (submitted_tts_chars >= 0);
ALTER TABLE speech_windows ADD CONSTRAINT speech_submitted_counter_receipt CHECK (
  (submitted_pcm_bytes IS NOT NULL) = (submitted_tts_chars IS NOT NULL)
  AND (settlement_basis IS NOT DISTINCT FROM 'submitted_counter_provider_unconfirmed') = (submitted_pcm_bytes IS NOT NULL)
);
