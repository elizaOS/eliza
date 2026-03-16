/**
 * Hook Loader — load and register hooks into the event system.
 *
 * Orchestrates discovery -> eligibility -> loading -> registration.
 *
 * @module hooks/loader
 */

import { pathToFileURL } from "node:url";
import { logger } from "@elizaos/core";
import type { InternalHooksConfig } from "../config/types.hooks.js";
import type { HookEntry, HookHandler } from "./types.js";
import { discoverHooks, type DiscoveryOptions } from "./discovery.js";
import { checkEligibility, resolveHookConfig } from "./eligibility.js";
import { registerHook, clearHooks } from "./registry.js";

// ---------- Dynamic Handler Loading ----------

/**
 * Dynamically import a hook handler module.
 * Uses cache-busting query parameter for dev mode hot reload.
 */
async function loadHandlerModule(
  handlerPath: string,
  exportName: string = "default",
): Promise<HookHandler | null> {
  try {
    const url = pathToFileURL(handlerPath).href;
    // Cache-busting for dev mode
    const mod = await import(`${url}?t=${Date.now()}`);
    const handler = mod[exportName];

    if (typeof handler !== "function") {
      logger.warn(
        `[hooks] Handler at ${handlerPath} does not export a function as "${exportName}"`,
      );
      return null;
    }

    return handler as HookHandler;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[hooks] Failed to load handler ${handlerPath}: ${msg}`);
    return null;
  }
}

// ---------- Main Loader ----------

export interface LoadHooksOptions extends DiscoveryOptions {
  /** Internal hooks configuration. */
  internalConfig?: InternalHooksConfig;
  /** Full Milaidy config for eligibility checks. */
  milaidyConfig?: Record<string, unknown>;
}

export interface LoadHooksResult {
  /** Total hooks discovered. */
  discovered: number;
  /** Hooks that passed eligibility. */
  eligible: number;
  /** Hooks successfully loaded and registered. */
  registered: number;
  /** Hooks that were skipped (disabled or ineligible). */
  skipped: string[];
  /** Hooks that failed to load. */
  failed: string[];
}

/**
 * Discover, filter, load, and register all hooks.
 *
 * This is the main entry point called during gateway startup.
 */
export async function loadHooks(
  options: LoadHooksOptions = {},
): Promise<LoadHooksResult> {
  const { internalConfig, milaidyConfig = {} } = options;

  // Check if hooks are enabled
  if (internalConfig?.enabled === false) {
    logger.info("[hooks] Internal hooks disabled");
    return { discovered: 0, eligible: 0, registered: 0, skipped: [], failed: [] };
  }

  // Clear existing hooks (for reload)
  clearHooks();

  // Discover hooks
  const entries = await discoverHooks({
    workspacePath: options.workspacePath,
    bundledDir: options.bundledDir,
    extraDirs: [
      ...(options.extraDirs ?? []),
      ...(internalConfig?.load?.extraDirs ?? []),
    ],
  });

  const result: LoadHooksResult = {
    discovered: entries.length,
    eligible: 0,
    registered: 0,
    skipped: [],
    failed: [],
  };

  // Process each hook
  for (const entry of entries) {
    const hookKey = entry.metadata?.hookKey ?? entry.hook.name;
    const hookConfig = resolveHookConfig(internalConfig, hookKey);

    // Check eligibility
    const eligibility = checkEligibility(
      entry.metadata,
      hookConfig,
      milaidyConfig,
    );

    if (!eligibility.eligible) {
      result.skipped.push(
        `${entry.hook.name}: ${eligibility.missing.join(", ")}`,
      );
      continue;
    }

    result.eligible++;

    // Check if explicitly disabled
    if (hookConfig?.enabled === false) {
      result.skipped.push(`${entry.hook.name}: disabled in config`);
      continue;
    }

    // Load handler
    const exportName = entry.metadata?.export ?? "default";
    const handler = await loadHandlerModule(entry.hook.handlerPath, exportName);

    if (!handler) {
      result.failed.push(entry.hook.name);
      continue;
    }

    // Register for all configured events
    const events = entry.metadata?.events ?? [];
    if (events.length === 0) {
      logger.warn(
        `[hooks] Hook "${entry.hook.name}" has no events configured`,
      );
      result.skipped.push(`${entry.hook.name}: no events`);
      continue;
    }

    for (const eventKey of events) {
      registerHook(eventKey, handler);
    }

    const emoji = entry.metadata?.emoji ?? "🔗";
    logger.info(
      `[hooks] ${emoji} Registered: ${entry.hook.name} -> ${events.join(", ")}`,
    );
    result.registered++;
  }

  // Load legacy config handlers (backwards compatibility)
  if (internalConfig?.handlers) {
    for (const legacyHandler of internalConfig.handlers) {
      try {
        const handler = await loadHandlerModule(
          legacyHandler.module,
          legacyHandler.export ?? "default",
        );
        if (handler) {
          registerHook(legacyHandler.event, handler);
          logger.info(
            `[hooks] Registered legacy handler: ${legacyHandler.event} -> ${legacyHandler.module}`,
          );
          result.registered++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[hooks] Failed to load legacy handler: ${msg}`);
        result.failed.push(legacyHandler.module);
      }
    }
  }

  logger.info(
    `[hooks] Load complete: ${result.registered}/${result.discovered} registered, ` +
      `${result.skipped.length} skipped, ${result.failed.length} failed`,
  );

  return result;
}
