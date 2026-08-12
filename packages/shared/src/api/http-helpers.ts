/**
 * Shared HTTP helpers surface.
 *
 * #18056: this package entry used to re-export bare `@elizaos/core`, which the
 * app Vite config aliases to the prebuilt ~2.4 MB browser blob. Any import of
 * these names from `@elizaos/shared` (including via the package barrel) then
 * dragged that blob into cold `/login`.
 *
 * Browser/renderer consumers get throw-on-call facades. Node/API code that
 * needs real body-reading helpers should import them from `@elizaos/core`
 * (or the agent route helpers that already wrap them).
 */
export type {
  ReadJsonBodyOptions,
  RequestBodyOptions,
} from "./http-helpers.browser.js";
export {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "./http-helpers.browser.js";
