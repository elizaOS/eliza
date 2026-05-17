/**
 * Hook Loader — load and register hooks into the event system.
 *
 * Orchestrates discovery -> eligibility -> loading -> registration.
 *
 * @module hooks/loader
 */

import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@elizaos/core";
import type { InternalHooksConfig } from "../config/types.hooks.ts";
import { type DiscoveryOptions, discoverHooks } from "./discovery.ts";
import { checkEligibility, resolveHookConfig } from "./eligibility.ts";
import { clearHooks, registerHook } from "./registry.ts";
import type { HookHandler } from "./types.ts";

// ---------- Path Safety ----------

/** Directories from which hook modules may be loaded. */
function getSafeHookRoots(
  workspacePath?: string,
  bundledDir?: string,
): string[] {
  const roots: string[] = [resolve(homedir(), ".eliza", "hooks")];
  if (bundledDir) roots.push(resolve(bundledDir));
  if (workspacePath) {
    roots.push(resolve(workspacePath.replace(/^~/, homedir()), "hooks"));
  }
  return roots;
}

/**
 * Ensure a module path resolves to a file under one of the allowed hook
 * roots.  Blocks absolute paths to arbitrary locations and path-traversal
 * attacks (e.g. "../../etc/malicious").
 */
async function normalizeRootPath(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  try {
    return await realpath(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

async function normalizeModulePath(modulePath: string): Promise<string | null> {
  const resolvedModulePath = resolve(modulePath);
  try {
    const stats = await lstat(resolvedModulePath);
    if (stats.isSymbolicLink()) {
      return await realpath(resolvedModulePath).catch(() => null);
    }
    return await realpath(resolvedModulePath).catch(() => resolvedModulePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return resolvedModulePath;
    }
    return null;
  }
}

async function isPathUnderRoots(
  modulePath: string,
  roots: string[],
): Promise<boolean> {
  const normalizedModulePath = await normalizeModulePath(modulePath);
  if (!normalizedModulePath) {
    return false;
  }

  return roots.some((root) => {
    const normalizedRoot = root.endsWith(sep) ? root : root + sep;
    return (
      normalizedModulePath.startsWith(normalizedRoot) ||
      normalizedModulePath === root
    );
  });
}

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
    const msg = String(err);
    logger.error(`[hooks] Failed to load handler ${handlerPath}: ${msg}`);
    return null;
  }
}

// ---------- Main Loader ----------

export interface LoadHooksOptions extends DiscoveryOptions {
  /** Internal hooks configuration. */
  internalConfig?: InternalHooksConfig;
  /** Full Eliza config for eligibility checks. */
  elizaConfig?: Record<string, unknown>;
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
  const { internalConfig, elizaConfig = {} } = options;

  // Check if hooks are enabled
  if (internalConfig?.enabled === false) {
    logger.info("[hooks] Internal hooks disabled");
    return {
      discovered: 0,
      eligible: 0,
      registered: 0,
      skipped: [],
      failed: [],
    };
  }

  // Clear existing hooks (for reload)
  clearHooks();

  // Validate config-supplied extraDirs: only allow paths under ~/.eliza/
  // to prevent config injection from scanning attacker-controlled directories.
  const safeExtraDirs = [...(options.extraDirs ?? [])];
  const elizaHome = resolve(homedir(), ".eliza");
  for (const dir of internalConfig?.load?.extraDirs ?? []) {
    const resolved = resolve(dir.replace(/^~/, homedir()));
    if (resolved.startsWith(elizaHome + sep) || resolved === elizaHome) {
      safeExtraDirs.push(dir);
    } else {
      logger.warn(
        `[hooks] Rejected config extraDir "${dir}": must be under ~/.eliza/`,
      );
    }
  }

  // Discover hooks
  const entries = await discoverHooks({
    workspacePath: options.workspacePath,
    bundledDir: options.bundledDir,
    extraDirs: safeExtraDirs,
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
      elizaConfig,
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
      logger.warn(`[hooks] Hook "${entry.hook.name}" has no events configured`);
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
    const safeRoots = await Promise.all(
      getSafeHookRoots(options.workspacePath, options.bundledDir).map(
        normalizeRootPath,
      ),
    );

    for (const legacyHandler of internalConfig.handlers) {
      // Validate module path is under a known hook directory to prevent
      // arbitrary code execution via config-injected module paths.
      if (!(await isPathUnderRoots(legacyHandler.module, safeRoots))) {
        logger.warn(
          `[hooks] Rejected legacy handler: module path "${legacyHandler.module}" is outside allowed hook directories`,
        );
        result.failed.push(legacyHandler.module);
        continue;
      }

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
        } else {
          result.failed.push(legacyHandler.module);
        }
      } catch (err) {
        const msg = String(err);
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
