CREATE TABLE speech_consents (
  nonce text PRIMARY KEY,
  user_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  credential_kind text NOT NULL CHECK (credential_kind IN ('device_key', 'session')),
  credential_ref text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX speech_consents_sweep ON speech_consents (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE speech_sessions (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  consent_nonce text NOT NULL UNIQUE REFERENCES speech_consents (nonce),
  user_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  credential_kind text NOT NULL CHECK (credential_kind IN ('device_key', 'session')),
  credential_ref text NOT NULL,
  credential_expires_at bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('consented', 'minted', 'starting', 'active', 'retiring', 'closed')),
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX speech_sessions_sweep ON speech_sessions (expires_at) WHERE phase <> 'closed';
CREATE INDEX speech_sessions_user ON speech_sessions (user_id);

CREATE TABLE speech_windows (
  session_id text NOT NULL REFERENCES speech_sessions (key),
  number integer NOT NULL CHECK (number >= 1),
  user_id text NOT NULL,
  usage_day bigint NOT NULL,
  speech_ms bigint NOT NULL CHECK (speech_ms >= 0),
  transcribe_hold text NOT NULL REFERENCES holds (key),
  synthesize_hold text NOT NULL REFERENCES holds (key),
  expires_at bigint NOT NULL,
  settled_at bigint,
  created_at bigint NOT NULL,
  PRIMARY KEY (session_id, number)
);
CREATE INDEX speech_windows_open ON speech_windows (session_id) WHERE settled_at IS NULL;

CREATE TABLE speech_usage_days (
  user_id text NOT NULL,
  usage_day bigint NOT NULL,
  used_ms bigint NOT NULL CHECK (used_ms >= 0),
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_id, usage_day)
);
