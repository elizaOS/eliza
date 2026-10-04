/** Compatibility entrypoint; storage error contracts belong to plugin-sql. */
export {
  createPgliteInitError,
  getPgliteErrorCode,
  PGLITE_ERROR_CODES,
  type PgliteErrorCode,
  PgliteInitError,
} from "@elizaos/plugin-sql/errors";
