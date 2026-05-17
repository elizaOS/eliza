/**
 * Re-export of @elizaos/core's sandbox-policy module so callers can import
 * from the conventional `app-core/src/runtime/sandbox-policy` path.
 * Canonical implementation lives in @elizaos/core (a leaf), letting any
 * package consult it without importing app-core.
 */

export {
  buildStoreVariantBlockedMessage,
  isLocalCodeExecutionAllowed,
} from "@elizaos/core";
