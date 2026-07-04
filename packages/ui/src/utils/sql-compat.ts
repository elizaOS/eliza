/**
 * Re-exports the shared SQL-compat helpers (identifier quoting/sanitizing, raw
 * exec) for the client SQL surface.
 */
export {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  quoteIdent,
  sanitizeIdentifier,
  sqlLiteral,
} from "@elizaos/shared";
