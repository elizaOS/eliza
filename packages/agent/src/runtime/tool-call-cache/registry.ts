/**
 * Cacheable-tool whitelist.
 *
 * The cache is opt-in. A tool only participates if it is registered here
 * with `cacheable: true`. The default for any tool not in the registry is
 * `cacheable: false` so side-effect tools (send_email, post_message,
 * write_file, run_code, …) are guaranteed never to short-circuit through
 * the cache, even if a future caller forgets to register them.
 *
 * TTLs default to 24h. Tools with shorter freshness needs (file reads
 * against a working tree) get short TTLs; tools whose results are stable
 * across days (search results, immutable web archives) get longer ones.
 */

import type { CacheableToolDescriptor } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CACHEABLE_TOOL_REGISTRY: Record<string, CacheableToolDescriptor> =
  {
    web_search: {
      name: "web_search",
      version: "1",
      ttlMs: 6 * HOUR_MS,
      cacheable: true,
    },
    web_fetch: {
      name: "web_fetch",
      version: "1",
      ttlMs: DAY_MS,
      cacheable: true,
    },
    file_read: {
      name: "file_read",
      version: "1",
      ttlMs: 5 * 60 * 1000,
      cacheable: true,
    },
    rag_search: {
      name: "rag_search",
      version: "1",
      ttlMs: HOUR_MS,
      cacheable: true,
    },
    knowledge_lookup: {
      name: "knowledge_lookup",
      version: "1",
      ttlMs: HOUR_MS,
      cacheable: true,
    },
  };

export function resolveToolDescriptor(
  name: string,
  overrides?: Partial<Pick<CacheableToolDescriptor, "ttlMs" | "version">>,
): CacheableToolDescriptor {
  const base = CACHEABLE_TOOL_REGISTRY[name];
  if (!base) {
    return {
      name,
      version: "1",
      ttlMs: 0,
      cacheable: false,
    };
  }
  return {
    ...base,
    ttlMs: overrides?.ttlMs ?? base.ttlMs,
    version: overrides?.version ?? base.version,
  };
}

export function isCacheable(name: string): boolean {
  return CACHEABLE_TOOL_REGISTRY[name]?.cacheable === true;
}
