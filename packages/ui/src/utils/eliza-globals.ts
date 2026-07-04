/**
 * Re-exports the window-scoped Eliza API base/token accessors so the client and
 * bridges read one global handle.
 */
export {
  clearElizaApiBase,
  clearElizaApiToken,
  type ElizaWindow,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "@elizaos/shared";
