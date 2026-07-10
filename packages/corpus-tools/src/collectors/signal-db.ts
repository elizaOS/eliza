/**
 * SQLCipher-backed read surface for the Signal Desktop database. Signal stores
 * every message in an encrypted `db.sqlite` (SQLCipher); once the `PRAGMA key`
 * is applied the queryable shape is ordinary SQLite. This module isolates the
 * two concerns so the collector stays testable: `SignalDatabase` is the small
 * query interface the collector consumes, and `openSqlcipherDatabase` is the
 * production adapter that applies the key and runs the queries.
 *
 * The adapter loads `better-sqlite3-multiple-ciphers` dynamically (an optional
 * dependency, needed only for a live owner-machine pull) and fails closed with a
 * typed `sqlcipher_unavailable` error when it is absent, rather than silently
 * degrading. Tests inject an in-memory `SignalDatabase` (or a plaintext SQLite
 * build of the same schema) so the row-selection and normalization path is
 * exercised against a real query engine without shipping the native cipher.
 */
import { logger } from "@elizaos/core";
import { CollectorError } from "./errors.ts";

/**
 * Raw row shape as it comes out of Signal's `messages` table joined to
 * `conversations`. Columns are nullable exactly as SQLite returns them; the
 * `json` column is the canonical message object and is parsed by the normalizer.
 */
export interface SignalMessageRow {
  id: string;
  json: string | null;
  sent_at: number | null;
  received_at: number | null;
  conversationId: string | null;
  type: string | null;
  body: string | null;
  source: string | null;
  sourceServiceId: string | null;
  conversationName: string | null;
  conversationType: string | null;
  conversationE164: string | null;
  conversationServiceId: string | null;
}

export interface SignalDatabase {
  /**
   * Return messages with `received_at >= cutoffMs`, ascending by
   * `(received_at, id)` so the collector can checkpoint forward deterministically.
   */
  queryMessages(cutoffMs: number): SignalMessageRow[];
  close(): void;
}

/** Minimal shape of the `better-sqlite3-multiple-ciphers` handle we rely on. */
interface CipherStatement {
  all(...params: unknown[]): unknown[];
}
interface CipherDatabase {
  pragma(source: string): unknown;
  prepare(sql: string): CipherStatement;
  close(): void;
}
type CipherDatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => CipherDatabase;

/**
 * Minimal SQLite execution surface both openers bind to. Keeping the collector's
 * query in one place means the SQLCipher production path and the plaintext test
 * path run the identical SQL against the identical schema — the only difference
 * is the encryption, which is exactly the owner-gated part.
 */
export interface SignalSqliteExec {
  all(sql: string, params: unknown[]): unknown[];
  close(): void;
}

// Signal joins each message to its conversation to recover peer identity for
// 1:1 threads; the row shape above mirrors this projection exactly.
export const SIGNAL_MESSAGE_QUERY = `
  SELECT
    m.id AS id,
    m.json AS json,
    m.sent_at AS sent_at,
    m.received_at AS received_at,
    m.conversationId AS conversationId,
    m.type AS type,
    m.body AS body,
    m.source AS source,
    m.sourceServiceId AS sourceServiceId,
    c.name AS conversationName,
    c.type AS conversationType,
    c.e164 AS conversationE164,
    c.serviceId AS conversationServiceId
  FROM messages m
  LEFT JOIN conversations c ON c.id = m.conversationId
  WHERE m.received_at >= ?
  ORDER BY m.received_at ASC, m.id ASC
`;

/**
 * Bind a `SignalDatabase` to any SQLite exec surface. Query failures become a
 * typed `db_query_failed` so a schema drift in a real Signal export surfaces at
 * the boundary rather than as a silently empty pull.
 */
export function createSignalDatabase(exec: SignalSqliteExec): SignalDatabase {
  return {
    queryMessages(cutoffMs: number): SignalMessageRow[] {
      try {
        return exec.all(SIGNAL_MESSAGE_QUERY, [cutoffMs]) as SignalMessageRow[];
      } catch (error) {
        throw new CollectorError("Signal message query failed", {
          collectorCode: "db_query_failed",
          platform: "signal",
          cause: error,
        });
      }
    },
    close(): void {
      try {
        exec.close();
      } catch (error) {
        // error-policy:J6 best-effort teardown of the read handle; a
        // double-close is benign and only logged for diagnostics.
        logger.debug(
          `[SignalDatabase] read handle close failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

// Kept non-literal so TypeScript does not statically resolve an optional native
// dependency that is only installed for a live owner-machine pull.
const CIPHER_MODULE_SPECIFIER = "better-sqlite3-multiple-ciphers";

async function loadCipherCtor(): Promise<CipherDatabaseCtor> {
  try {
    const mod = (await import(/* @vite-ignore */ CIPHER_MODULE_SPECIFIER)) as {
      default?: CipherDatabaseCtor;
    } & CipherDatabaseCtor;
    const ctor = (mod.default ?? mod) as CipherDatabaseCtor;
    if (typeof ctor !== "function") {
      throw new Error("module did not export a Database constructor");
    }
    return ctor;
  } catch (error) {
    // error-policy:J1 boundary: a live Signal pull requires the native cipher.
    // Its absence is fail-closed, not a degraded empty read.
    throw new CollectorError(
      "better-sqlite3-multiple-ciphers is required for a live Signal pull",
      {
        collectorCode: "sqlcipher_unavailable",
        platform: "signal",
        cause: error,
      },
    );
  }
}

/**
 * Open a copy of Signal's encrypted `db.sqlite` read-only and bind it to the
 * message query. Applies `PRAGMA key`, then a lightweight probe query so a wrong
 * key or corrupt file fails here (typed `db_open_failed`) rather than surfacing
 * as an empty message list downstream.
 */
export async function openSqlcipherDatabase(
  dbPath: string,
  keyHex: string,
): Promise<SignalDatabase> {
  const Database = await loadCipherCtor();
  let db: CipherDatabase;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // SQLCipher takes the raw 256-bit key as a hex literal; `PRAGMA cipher_...`
    // stays at Signal's defaults (SQLCipher 4) so we don't override page size.
    db.pragma(`key = "x'${keyHex}'"`);
    // Force a read so an incorrect key fails now with a decrypt error.
    db.prepare("SELECT count(*) AS n FROM sqlite_master").all();
  } catch (error) {
    throw new CollectorError("failed to open the Signal database copy", {
      collectorCode: "db_open_failed",
      platform: "signal",
      cause: error,
      context: { dbPath },
    });
  }

  return createSignalDatabase({
    all(sql: string, params: unknown[]): unknown[] {
      return db.prepare(sql).all(...params);
    },
    close(): void {
      db.close();
    },
  });
}

export type SignalDatabaseOpener = (
  dbPath: string,
  keyHex: string,
) => Promise<SignalDatabase>;
