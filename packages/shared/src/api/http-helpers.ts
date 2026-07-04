/** Re-exports the core HTTP request/response helpers (body reading, JSON send) so shared consumers avoid a direct `@elizaos/core` import. */
export type {
  ReadJsonBodyOptions,
  RequestBodyOptions,
} from "@elizaos/core";
export {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
