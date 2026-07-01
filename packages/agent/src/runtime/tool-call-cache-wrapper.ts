/**
 * Tool-call cache wiring for the agent runtime.
 *
 * Wraps the `handler` of every registered Action that the cache registry
 * marks as `cacheable: true` so the result of a (toolName, args) pair is
 * served from the two-tier `ToolCallCache` instead of re-running the
 * underlying tool. Side-effect tools and any tool not in the cacheable-tool
 * registry pass through unchanged.
 *
 * `plugin-lifecycle.ts` calls `wrapActionWithCache(action, cache, cfg)` per
 * action after building the cache from config. Per-tool TTL overrides come
 * from the `tools.cache` config block (see `zod-schema.agent-runtime.ts`).
 */

import type {
  Action,
  ActionResult,
  Handler,
  HandlerOptions,
} from "@elizaos/core";
import {
  type CacheableToolDescriptor,
  defaultPrivacyRedactor,
  isCacheable,
  resolveToolDescriptor,
  ToolCallCache,
  type ToolOutput,
} from "./tool-call-cache/index.ts";

interface PerToolOverride {
  ttlMinutes?: number;
  version?: string;
}

type CachedActionResult = ActionResult & { [key: string]: ToolOutput };

export interface ToolCacheConfig {
  enabled?: boolean;
  memoryCapacity?: number;
  diskRoot?: string;
  perTool?: Record<string, PerToolOverride>;
}

/**
 * Build a ToolCallCache from agent runtime config. Returns null when the
 * cache is disabled so callers can skip the wrap-step entirely.
 */
export function createToolCallCacheFromConfig(
  cfg: ToolCacheConfig | undefined,
): ToolCallCache | null {
  if (cfg && cfg.enabled === false) return null;
  return new ToolCallCache({
    diskRoot: cfg?.diskRoot,
    memoryCapacity: cfg?.memoryCapacity,
    redact: defaultPrivacyRedactor,
  });
}

function resolveDescriptor(
  name: string,
  cfg: ToolCacheConfig | undefined,
): CacheableToolDescriptor {
  const override = cfg?.perTool?.[name];
  return resolveToolDescriptor(name, {
    ttlMs:
      override?.ttlMinutes !== undefined
        ? override.ttlMinutes * 60_000
        : undefined,
    version: override?.version,
  });
}

function extractArgs(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const opts = options as HandlerOptions;
  if (opts.parameters && typeof opts.parameters === "object") {
    return opts.parameters as Record<string, unknown>;
  }
  return {};
}

function isToolOutput(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): value is ToolOutput {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;

  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((entry) => isToolOutput(entry, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  return Object.values(value).every((entry) => isToolOutput(entry, seen));
}

function isCachedActionResult(value: ToolOutput): value is CachedActionResult {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.success === "boolean"
  );
}

/**
 * Wrap an Action's handler so cacheable tools route through the cache.
 * Non-cacheable actions are returned unchanged.
 */
export function wrapActionWithCache(
  action: Action,
  cache: ToolCallCache,
  cfg: ToolCacheConfig | undefined,
): Action {
  if (!isCacheable(action.name)) return action;
  const descriptor = resolveDescriptor(action.name, cfg);
  const original: Handler = action.handler;

  const wrapped: Handler = async (
    runtime,
    message,
    state,
    options,
    ...rest
  ) => {
    const args = extractArgs(options);
    const hit = cache.get(descriptor, args);
    if (hit && isCachedActionResult(hit.output)) return hit.output;

    const result = await original(runtime, message, state, options, ...rest);
    if (result !== undefined && isToolOutput(result)) {
      cache.set(descriptor, args, result);
    }
    return result;
  };

  return { ...action, handler: wrapped };
}
