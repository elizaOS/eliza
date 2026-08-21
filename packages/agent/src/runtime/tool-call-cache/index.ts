/**
 * Public barrel for the tool-call result cache: re-exports the ToolCallCache
 * store, cache-key building and JSON canonicalization, the default privacy
 * redactor, the cacheable-tool registry (descriptor lookup + isCacheable), and
 * the shared cache types.
 */
export type {
  BoundedWalkOptions,
  BoundedWalkRejection,
  BoundedWalkResult,
} from "./bounded-walk.ts";
export { boundedWalk, TOOL_OUTPUT_LIMITS } from "./bounded-walk.ts";
export type { ToolCallCacheOptions } from "./cache.ts";
export { isCacheableToolOutput, ToolCallCache } from "./cache.ts";
export type {
  CacheKeyRejection,
  CacheKeyResult,
  CanonicalizeLimits,
  CanonicalizeResult,
} from "./key.ts";
export {
  buildCacheKey,
  CACHE_KEY_LIMITS,
  canonicalizeJson,
  ToolCacheKeyBoundError,
  tryBuildCacheKey,
  tryCanonicalizeJson,
} from "./key.ts";
export {
  defaultPrivacyRedactor,
  isRedactionDegraded,
} from "./redact.ts";
export {
  CACHEABLE_TOOL_REGISTRY,
  isCacheable,
  resolveToolDescriptor,
} from "./registry.ts";
export type {
  CacheableToolDescriptor,
  PrivacyRedactor,
  ToolArgs,
  ToolCacheEntry,
  ToolOutput,
} from "./types.ts";
