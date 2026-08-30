/**
 * Re-exports the canonical `stringToUuid` from `@elizaos/core` so plugin-sql
 * never forks the natural-key → UUID derivation. This id is security-relevant:
 * `createDatabaseAdapter` derives the RLS `server_id` (used for row stamping
 * and tenant filtering) from `ELIZA_SERVER_ID` via this function, and other
 * code derives ids from natural keys on both sides of the core/plugin-sql
 * boundary. A local FNV-1a implementation previously diverged byte-for-byte
 * from core's SHA-1 derivation, so the same key mapped to two different UUIDs.
 * Delegating to core keeps a single source of truth across every build target
 * (core's browser bundle exports the same WebCrypto/pure-JS implementation).
 */
export { stringToUuid } from "@elizaos/core";
