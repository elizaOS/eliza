CREATE TABLE IF NOT EXISTS cloud_speech_consents (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(key) ON DELETE CASCADE,
  credential_kind text NOT NULL CHECK (credential_kind IN ('browser', 'device')),
  credential_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cloud_speech_consents_account_time_idx ON cloud_speech_consents(account_id, issued_at);

CREATE TABLE IF NOT EXISTS cloud_speech_sessions (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(key) ON DELETE CASCADE,
  credential_kind text NOT NULL CHECK (credential_kind IN ('browser', 'device')),
  credential_hash text NOT NULL,
  token_hash text NOT NULL,
  stt_hold_key text UNIQUE REFERENCES holds(key),
  tts_hold_key text UNIQUE REFERENCES holds(key),
  stt_micros_per_second bigint NOT NULL CHECK (stt_micros_per_second >= 0),
  tts_micros_per_character bigint NOT NULL CHECK (tts_micros_per_character >= 0),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  revoked_at timestamptz,
  settled_at timestamptz,
  pcm_bytes integer CHECK (pcm_bytes >= 0 AND pcm_bytes <= 1920000),
  tts_characters integer CHECK (tts_characters >= 0 AND tts_characters <= 4096)
);

CREATE INDEX IF NOT EXISTS cloud_speech_sessions_account_time_idx ON cloud_speech_sessions(account_id, admitted_at);


CREATE OR REPLACE VIEW cloud_speech_credentials AS
SELECT 'browser'::text AS kind, s.access_digest AS token_hash, s.user_id AS account_id, NULL::text AS client_id,
  to_timestamp(s.access_expires_at / 1000.0) AS expires_at
FROM sessions s
JOIN accounts a ON a.key = s.user_id
WHERE s.live AND a.status = 'active' AND (s.state->>'epoch')::bigint = a.sessions_revoked_before
UNION ALL
SELECT 'device'::text AS kind, d.secret_digest AS token_hash, d.user_id AS account_id, d.client_id,
  to_timestamp(d.key_expires_at / 1000.0) AS expires_at
FROM device_grants d
JOIN accounts a ON a.key = d.user_id
WHERE d.phase = 'active' AND a.status = 'active' AND d.issued_at >= a.devices_revoked_before;
