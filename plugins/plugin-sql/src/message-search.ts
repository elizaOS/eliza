/**
 * Postgres full-text + trigram search objects for chat message search at scale
 * (#13534). Chat messages are `memories` rows (`type='messages'`, body at
 * `content->>'text'`); this module installs the immutable folding + document
 * functions and the two GIN indexes that let `BaseDrizzleAdapter.searchMessages`
 * run corpus-wide `websearch_to_tsquery` + `ts_rank_cd` ranking instead of the
 * old recency-truncated `ILIKE` scan.
 *
 * Why a custom immutable fold instead of `unaccent`: `unaccent` is not immutable
 * (its rules live in a mutable dictionary) and the bundled PGlite build does not
 * ship it, so accent/case/apostrophe folding is a fixed `translate()` map
 * (café→cafe, don't→dont) that IS immutable and therefore usable in a generated
 * column and expression index.
 *
 * Why a STORED generated column (`message_search_document`) rather than indexing
 * the function expression directly: the fold+document function does jsonb
 * parsing, an attachment `string_agg` subquery, and a `translate()` per call.
 * Evaluating it per row at query time makes any query that cannot be answered by
 * the FTS GIN index alone (the `pg_trgm` partial-word fallback, or an FTS-index
 * miss) an O(n) scan that recomputes the document for every row — 10k rows × the
 * function ≈ seconds. Materializing the document once at write time (the column
 * is computed on INSERT/UPDATE) turns that fallback into a plain indexed / cheap
 * text scan. The FTS GIN indexes `to_tsvector(message_search_document)` and the
 * trigram GIN indexes the column with `gin_trgm_ops`; the query references the
 * column, so the planner uses the indexes and never recomputes the function.
 * `pg_trgm` is best-effort: where it is unavailable the FTS index still answers
 * whole-word queries and the `LIKE` fallback scans the cheap stored column, so
 * partial/substring recall degrades in speed, never in correctness.
 */
import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DrizzleDatabase } from "./types";

export const FTS_CONFIG = "english";
export const MESSAGE_SEARCH_TABLE_TYPE = "messages";

// Accent-folding map: each accented Latin letter → its ASCII base. `from` and
// `to` are equal length; the three trailing chars in `from` (straight/curly
// apostrophe, backtick) have no `to` counterpart and are therefore deleted by
// translate() so "don't" folds to "dont".
const ACCENT_FROM = "àáâãäåāăąèéêëēĕėęěìíîïĩīĭįòóôõöøōŏőùúûüũūŭůűñçćčšžýÿ";
const ACCENT_TO = "aaaaaaaaaeeeeeeeeeiiiiiiiiooooooooouuuuuuuuuncccszyy";
const STRIP_CHARS = "'’`";

/** SQL string literal for `translate`'s `from` set, single-quotes doubled. */
const FOLD_FROM_LITERAL = (ACCENT_FROM + STRIP_CHARS).replace(/'/g, "''");

/**
 * Create (idempotently) the folding/document functions and the FTS + trigram
 * indexes. Safe to run on every startup after migrations. Returns whether the
 * `pg_trgm` trigram index is available so the query layer can decide whether to
 * emit `similarity()` / gin_trgm_ops-accelerated `LIKE`.
 */
export async function applyMessageSearchObjects(
  db: DrizzleDatabase
): Promise<{ trigramAvailable: boolean }> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_search_fold(t text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fold$
      SELECT translate(lower(t), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')
    $fold$;
  `);

  // The searchable document: message body plus attachment titles/URLs, folded.
  // The `translate(lower(...))` fold is inlined here rather than calling
  // `eliza_search_fold` because a nested user-function call cannot be resolved
  // when Postgres inlines this function into an expression index (it re-parses
  // the body with a restricted search_path). The map is kept identical to
  // `eliza_search_fold` by sourcing both from the same constants.
  // `jsonb_array_elements` is guarded so a non-array `attachments` value cannot
  // raise inside the immutable function (which would break the expression index).
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_message_search_document(content jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $doc$
      SELECT translate(lower(
        coalesce(content->>'text', '')
        || ' ' ||
        coalesce((
          SELECT string_agg(coalesce(a->>'title', '') || ' ' || coalesce(a->>'url', ''), ' ')
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(content->'attachments') = 'array'
                 THEN content->'attachments' ELSE '[]'::jsonb END
          ) AS a
        ), '')
      ), '${sql.raw(FOLD_FROM_LITERAL)}', '${sql.raw(ACCENT_TO)}')
    $doc$;
  `);

  // Escaped `%folded%` LIKE pattern so user `%`/`_`/`\` match literally.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION eliza_search_like_pattern(t text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $like$
      SELECT '%' || replace(replace(replace(eliza_search_fold(t), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
    $like$;
  `);

  // Materialize the folded document once per row. `CASE WHEN type='messages'`
  // keeps the stored text off every non-message memory (facts, embeddings, …) so
  // the column only costs storage for chat rows. Generated STORED so the value
  // is computed on write and read straight from the heap at query time.
  await db.execute(sql`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS message_search_document text
    GENERATED ALWAYS AS (
      CASE WHEN type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}'
           THEN eliza_message_search_document(content) ELSE NULL END
    ) STORED;
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memories_message_fts ON memories
    USING gin (to_tsvector('${sql.raw(FTS_CONFIG)}', message_search_document))
    WHERE type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}';
  `);

  let trigramAvailable = false;
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_memories_message_trgm ON memories
      USING gin (message_search_document gin_trgm_ops)
      WHERE type = '${sql.raw(MESSAGE_SEARCH_TABLE_TYPE)}';
    `);
    trigramAvailable = true;
  } catch (error) {
    // error-policy:J4 pg_trgm is an optional accelerator — degrade to FTS +
    // unindexed LIKE (correct, just slower for partial-word/substring recall).
    logger.warn(
      {
        src: "plugin:sql",
        error: error instanceof Error ? error.message : String(error),
      },
      "[MessageSearch] pg_trgm unavailable; trigram acceleration disabled (FTS still active)"
    );
  }

  logger.info(
    { src: "plugin:sql", trigramAvailable },
    "[MessageSearch] full-text search objects applied"
  );
  return { trigramAvailable };
}
