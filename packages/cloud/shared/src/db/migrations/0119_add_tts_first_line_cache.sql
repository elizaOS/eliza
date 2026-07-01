-- TTS first-line cache manifest.
--
-- Sister to the local sqlite cache in plugins/plugin-local-inference/
-- src/services/voice/first-line-cache.ts. Stores the LRU manifest for
-- first-sentence (≤ 10-word) TTS snippets. Audio bytes live in R2 at
-- `tts-first-line/<provider>/<voice_id>/<voice_revision>/<key_hash>.<ext>`.
--
-- Scope:
--   - 'global'             default ElevenLabs voices, deduplicated across orgs.
--   - 'org:<uuid>'         custom user-cloned voices (per R4 §6 / X7).

CREATE TABLE IF NOT EXISTS "tts_first_line_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  "key_hash"          text NOT NULL,
  "scope"             text NOT NULL,
  "algo_version"      text NOT NULL,
  "provider"          text NOT NULL,
  "voice_id"          text NOT NULL,
  "voice_revision"    text NOT NULL,
  "sample_rate"       integer NOT NULL,
  "codec"             text NOT NULL,
  "voice_settings_fp" text NOT NULL,
  "normalized_text"   text NOT NULL,

  "raw_text"          text NOT NULL,
  "content_type"      text NOT NULL,
  "duration_ms"       integer NOT NULL DEFAULT 0,
  "byte_size"         bigint NOT NULL,
  "word_count"        integer NOT NULL,
  "blob_key"          text NOT NULL,
  "hit_count"         integer NOT NULL DEFAULT 0,

  "generated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "last_accessed_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ix_tts_first_line_key_hash_scope"
  ON "tts_first_line_cache" ("key_hash", "scope");
CREATE INDEX IF NOT EXISTS "ix_tts_first_line_last_accessed"
  ON "tts_first_line_cache" ("last_accessed_at");
CREATE INDEX IF NOT EXISTS "ix_tts_first_line_provider_voice"
  ON "tts_first_line_cache" ("provider", "voice_id", "voice_revision");
CREATE INDEX IF NOT EXISTS "ix_tts_first_line_scope"
  ON "tts_first_line_cache" ("scope");
