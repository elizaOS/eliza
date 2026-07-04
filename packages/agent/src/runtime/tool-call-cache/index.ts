/**
 * Public barrel for the tool-call result cache: re-exports the ToolCallCache
 * store, cache-key building and JSON canonicalization, the default privacy
 * redactor, the cacheable-tool registry (descriptor lookup + isCacheable), and
 * the shared cache types.
 */
export type { ToolCallCacheOptions } from "./cache.ts";
export { ToolCallCache } from "./cache.ts";
export { buildCacheKey, canonicalizeJson } from "./key.ts";
export { defaultPrivacyRedactor } from "./redact.ts";
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
