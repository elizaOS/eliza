/**
 * Re-export of the tool-call cache surface.
 *
 * The implementation lives in @elizaos/agent under runtime/tool-call-cache
 * because the runtime wrapper is the primary integration point and the
 * agent package cannot depend on app-core (the dependency edge runs the
 * other way). This file exposes the cache from the canonical app-core
 * services path so external callers can locate it without reaching into
 * the agent package layout.
 */

export type {
  CacheableToolDescriptor,
  PrivacyRedactor,
  ToolArgs,
  ToolCacheEntry,
  ToolCallCacheOptions,
  ToolOutput,
} from "../../../../agent/src/runtime/tool-call-cache/index.ts";
export {
  buildCacheKey,
  CACHEABLE_TOOL_REGISTRY,
  canonicalizeJson,
  defaultPrivacyRedactor,
  isCacheable,
  resolveToolDescriptor,
  ToolCallCache,
} from "../../../../agent/src/runtime/tool-call-cache/index.ts";
