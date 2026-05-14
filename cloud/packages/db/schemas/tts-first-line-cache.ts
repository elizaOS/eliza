/**
 * TTS first-line cache manifest (Eliza Cloud).
 *
 * Sister table to the local `tts_first_line` sqlite cache shipped in
 * `plugins/plugin-local-inference/src/services/voice/first-line-cache.ts`.
 * The cloud side caches the first-sentence snip of every assistant TTS
 * request, keyed on `(algo_version, provider, voice_id, voice_revision,
 * sample_rate, codec, voice_settings_fp, normalized_text)` so byte-equal
 * playback is impossible across voices (F3 regression guard).
 *
 * Storage split:
 *   - audio bytes live in R2 (BLOB binding) at key
 *     `tts-first-line/<provider>/<voice_id>/<voice_revision>/<key_hash>.<ext>`
 *   - this table holds the manifest + LRU bookkeeping (`last_accessed_at`,
 *     `hit_count`) + cost-attribution metadata + privacy scope.
 *
 * Cross-org sharing rule (see R4 §6 + §X7):
 *   - `scope = "global"` for ElevenLabs default voices (deduplicated across
 *     orgs since bytes are identical).
 *   - `scope = "org:<orgId>"` for any voice resolved through
 *     `userVoicesRepository.findByElevenLabsVoiceId(...)` (custom user
 *     clones). Org-scoped entries never serve outside the owning org.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ttsFirstLineCache = pgTable(
  "tts_first_line_cache",
  {
    // Identity ----------------------------------------------------------
    id: uuid("id").defaultRandom().primaryKey(),
    /** sha256(algoVersion|provider|voiceId|voiceRevision|sampleRate|codec|voiceSettingsFp|normalizedText) */
    keyHash: text("key_hash").notNull(),
    /** `"global"` or `"org:<orgId>"`. Lookup must include the scope to
     *  avoid cross-org bleed of custom voice clones. */
    scope: text("scope").notNull(),

    // Cache key fields --------------------------------------------------
    algoVersion: text("algo_version").notNull(),
    provider: text("provider").notNull(),
    voiceId: text("voice_id").notNull(),
    voiceRevision: text("voice_revision").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    codec: text("codec").notNull(),
    voiceSettingsFp: text("voice_settings_fp").notNull(),
    normalizedText: text("normalized_text").notNull(),

    // Diagnostics + LRU -------------------------------------------------
    rawText: text("raw_text").notNull(),
    contentType: text("content_type").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    wordCount: integer("word_count").notNull(),
    blobKey: text("blob_key").notNull(),
    hitCount: integer("hit_count").notNull().default(0),

    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqKeyHashScope: index("ix_tts_first_line_key_hash_scope").on(table.keyHash, table.scope),
    ixLastAccessed: index("ix_tts_first_line_last_accessed").on(table.lastAccessedAt),
    ixProviderVoice: index("ix_tts_first_line_provider_voice").on(
      table.provider,
      table.voiceId,
      table.voiceRevision,
    ),
    ixScope: index("ix_tts_first_line_scope").on(table.scope),
  }),
);

export type TtsFirstLineCacheRow = InferSelectModel<typeof ttsFirstLineCache>;
export type TtsFirstLineCacheInsert = InferInsertModel<typeof ttsFirstLineCache>;
