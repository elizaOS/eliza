import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { logger } from "@elizaos/core";
import { formatError, isMobilePlatform } from "@elizaos/shared";

import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

type DeferredStaticPluginRegistration = {
  packageName: string;
  registryName?: string;
  required: boolean;
  load: () => Promise<unknown>;
};

function resolveWorkspacePluginSourceEntry(packageName: string): string | null {
  if (!packageName.startsWith("@elizaos/plugin-")) return null;
  const shortName = packageName.slice("@elizaos/".length);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 14; depth += 1) {
    const candidate = path.join(dir, "plugins", shortName, "src", "index.ts");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const loadOptionalPlugin = async (packageName: string): Promise<unknown> => {
  try {
    if (packageName === "@elizaos/plugin-agent-orchestrator") {
      return await import(
        /* @vite-ignore */ "@elizaos/plugin-agent-orchestrator"
      );
    }
    if (packageName === "@elizaos/plugin-task-coordinator") {
      return await import(
        /* @vite-ignore */ "@elizaos/plugin-task-coordinator"
      );
    }
    if (packageName === "@elizaos/plugin-app-control") {
      const appControlPackageName = packageName;
      return await import(/* @vite-ignore */ appControlPackageName);
    }
    if (packageName === "@elizaos/plugin-shell") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-shell");
    }
    if (packageName === "@elizaos/plugin-coding-tools") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-coding-tools");
    }
    if (packageName === "@elizaos/plugin-pty") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-pty");
    }
    if (packageName === "@elizaos/plugin-birdclaw") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-birdclaw");
    }
    if (packageName === "@elizaos/plugin-ollama") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-ollama");
    }
    if (packageName === "@elizaos/plugin-elizacloud") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-elizacloud");
    }
    if (packageName === "@elizaos/plugin-commands") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-commands");
    }
    if (packageName === "@elizaos/plugin-video") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-video");
    }
    if (packageName === "@elizaos/plugin-vision") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-vision");
    }
    if (packageName === "@elizaos/plugin-background-runner") {
      return await import(
        /* @vite-ignore */ "@elizaos/plugin-background-runner"
      );
    }
    if (packageName === "@elizaos/plugin-anthropic") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-anthropic");
    }
    if (packageName === "@elizaos/plugin-openai") {
      return await import(/* @vite-ignore */ "@elizaos/plugin-openai");
    }
    return await import(packageName);
  } catch {
    const sourceEntry = resolveWorkspacePluginSourceEntry(packageName);
    if (sourceEntry) {
      try {
        logger.debug(
          `[eliza] Loading ${packageName} from workspace source at ${sourceEntry}`,
        );
        return await import(pathToFileURL(sourceEntry).href);
      } catch {
        // Fall through to the existing optional-plugin behavior: missing or
        // unbuildable optional plugins are omitted from STATIC_ELIZA_PLUGINS.
      }
    }
    return null;
  }
};

let optionalPluginCache: Map<string, Promise<unknown>> | null = null;
function getOptionalPlugin(packageName: string): Promise<unknown> {
  if (optionalPluginCache === null) {
    optionalPluginCache = new Map();
  }
  const cache = optionalPluginCache;
  const cached = cache.get(packageName);
  if (cached) return cached;
  const promise = loadOptionalPlugin(packageName);
  cache.set(packageName, promise);
  return promise;
}

const DEFERRED_STATIC_PLUGIN_REGISTRATIONS: readonly DeferredStaticPluginRegistration[] =
  [
    {
      packageName: "@elizaos/plugin-agent-orchestrator",
      registryName: "agent-orchestrator",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-agent-orchestrator"),
    },
    {
      packageName: "@elizaos/plugin-task-coordinator",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-task-coordinator"),
    },
    {
      packageName: "@elizaos/plugin-shell",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-shell"),
    },
    {
      packageName: "@elizaos/plugin-coding-tools",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-coding-tools"),
    },
    {
      // Opt-in only: dormant unless a character lists @elizaos/plugin-pty (no
      // autoEnable). Registers PTY_SERVICE so the web terminal can drive a real
      // interactive CLI (eliza-code on Eliza Cloud/cerebras).
      packageName: "@elizaos/plugin-pty",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-pty"),
    },
    {
      // Auto-on only when the host has the birdclaw CLI or an existing
      // ~/.birdclaw data root (see birdclawRequested in plugin-collector.ts).
      // Registers BIRDCLAW_SERVICE + the local Twitter/X archive view/action.
      packageName: "@elizaos/plugin-birdclaw",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-birdclaw"),
    },
    {
      packageName: "@elizaos/plugin-commands",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-commands"),
    },
    {
      packageName: "@elizaos/plugin-video",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-video"),
    },
    {
      packageName: "@elizaos/plugin-vision",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-vision"),
    },
    {
      packageName: "@elizaos/plugin-background-runner",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-background-runner"),
    },
    {
      packageName: "@elizaos/plugin-elizacloud",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-elizacloud"),
    },
    {
      packageName: "@elizaos/plugin-ollama",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-ollama"),
    },
    {
      packageName: "@elizaos/plugin-anthropic",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-anthropic"),
    },
    {
      packageName: "@elizaos/plugin-openai",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-openai"),
    },
    {
      packageName: "@elizaos/plugin-gitpathologist",
      required: false,
      // Not in the mobile bundle — attempting the import there hangs the full
      // 30s deferred-plugin timeout before being skipped. Skip it up front on
      // android/ios (it's a desktop dev tool, already gated in plugin-collector).
      load: () =>
        isMobilePlatform()
          ? Promise.resolve(null)
          : getOptionalPlugin("@elizaos/plugin-gitpathologist"),
    },
  ];

async function trackDeferredStaticImport(
  registration: DeferredStaticPluginRegistration,
  bootTimeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `plugin ${registration.packageName} timed out after ${bootTimeoutMs}ms`,
        ),
      );
    }, bootTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    const mod = await Promise.race([registration.load(), timeout]);
    if (!mod) {
      if (registration.required) {
        throw new Error(`${registration.packageName} resolved to null`);
      }
      logger.warn(
        `[boot] ${registration.packageName} skipped after ${Date.now() - startedAt}ms: module unavailable`,
      );
      return;
    }
    STATIC_ELIZA_PLUGINS[
      registration.registryName ?? registration.packageName
    ] = mod;
    logger.info(
      `[boot] ${registration.packageName} loaded in ${Date.now() - startedAt}ms`,
    );
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    if (registration.required) {
      logger.error(
        `[boot] ${registration.packageName} FAILED after ${elapsed}ms: ${formatError(err)}`,
      );
      throw err;
    }
    logger.warn(
      `[boot] ${registration.packageName} skipped after ${elapsed}ms: ${formatError(err)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerDeferredCoreStaticPlugins(options?: {
  bootTimeoutMs?: number;
}): Promise<void> {
  const bootTimeoutMs = options?.bootTimeoutMs ?? 30_000;
  logger.info(
    `[boot] resolving deferred plugins (${DEFERRED_STATIC_PLUGIN_REGISTRATIONS.length}, timeout=${bootTimeoutMs}ms)`,
  );

  for (const registration of DEFERRED_STATIC_PLUGIN_REGISTRATIONS) {
    await trackDeferredStaticImport(registration, bootTimeoutMs);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function registerStaticPluginsByName(
  packageNames: readonly string[],
  options?: { bootTimeoutMs?: number },
): Promise<void> {
  const requested = new Set(packageNames);
  if (requested.size === 0) return;

  const registrations = DEFERRED_STATIC_PLUGIN_REGISTRATIONS.filter(
    (registration) =>
      requested.has(registration.packageName) ||
      (registration.registryName
        ? requested.has(registration.registryName)
        : false),
  );

  await Promise.all(
    registrations.map((registration) =>
      trackDeferredStaticImport(registration, options?.bootTimeoutMs ?? 30_000),
    ),
  );
}

export async function loadDeferredStaticPluginModule(
  packageName: string,
): Promise<unknown> {
  return await getOptionalPlugin(packageName);
}
