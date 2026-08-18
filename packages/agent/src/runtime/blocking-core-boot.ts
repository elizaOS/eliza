/**
 * Registers core plugins in dependency waves and owns the pre-initialization
 * barrier for readiness-critical services. Required plugins fail boot closed;
 * already registered plugins are skipped across blocking and deferred phases.
 */
import { type AgentRuntime, ElizaError, logger } from "@elizaos/core";
import { formatError } from "@elizaos/shared";
import { CORE_PLUGINS } from "./core-plugins.ts";
import type { ResolvedPlugin } from "./plugin-types.ts";
import { applyHostActionOwnership } from "./runtime-action-ownership.ts";

const CORE_PLUGIN_BOOT_DEPENDENCIES = new Map<string, readonly string[]>([
  ["@elizaos/plugin-agent-skills", ["@elizaos/plugin-coding-tools"]],
]);

export async function preregisterCorePluginsInDependencyWaves(args: {
  runtime: AgentRuntime;
  resolvedPlugins: ResolvedPlugin[];
  alreadyPreRegistered: Set<string>;
  requiredPluginNames?: ReadonlySet<string>;
  label?: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const registered = new Set([
    ...args.alreadyPreRegistered,
    ...(args.runtime.plugins ?? [])
      .map((plugin) => plugin.name)
      .filter((name): name is string => typeof name === "string"),
  ]);
  const pending = new Map<string, ResolvedPlugin>();
  for (const name of CORE_PLUGINS) {
    if (registered.has(name)) continue;
    const resolved = args.resolvedPlugins.find(
      (plugin) => plugin.name === name,
    );
    if (!resolved) {
      if (args.requiredPluginNames?.has(name)) {
        throw new ElizaError(
          `Required core plugin ${name} was not resolved for pre-registration`,
          {
            code: "REQUIRED_CORE_PLUGIN_REGISTRATION_FAILED",
            severity: "fatal",
            context: { plugin: name, phase: args.label ?? "core" },
          },
        );
      }
      logger.debug(
        `[eliza] Core plugin ${name} not resolved — skipping pre-registration`,
      );
      continue;
    }
    pending.set(name, resolved);
  }

  const context = args.label ? `${args.label}: ` : "";
  const registerOne = async (
    name: string,
    resolved: ResolvedPlugin,
  ): Promise<void> => {
    try {
      args.abortSignal?.throwIfAborted();
      const startedAt = Date.now();
      logger.debug(`[eliza] ${context}Pre-registering core plugin: ${name}...`);
      await args.runtime.registerPlugin(
        applyHostActionOwnership(args.runtime, resolved.plugin),
      );
      registered.add(name);
      logger.debug(
        `[eliza] ${context}✓ ${name} pre-registered (${Date.now() - startedAt}ms)`,
      );
    } catch (error) {
      if (args.abortSignal?.aborted) throw error;
      if (args.requiredPluginNames?.has(name)) {
        throw new ElizaError(
          `Required core plugin ${name} failed pre-registration`,
          {
            code: "REQUIRED_CORE_PLUGIN_REGISTRATION_FAILED",
            severity: "fatal",
            context: { plugin: name, phase: args.label ?? "core" },
            cause: error,
          },
        );
      }
      registered.add(name);
      logger.warn(
        `[eliza] ${context}Core plugin ${name} pre-registration failed: ${formatError(error)}`,
      );
    } finally {
      pending.delete(name);
    }
  };

  while (pending.size > 0) {
    args.abortSignal?.throwIfAborted();
    const ready: Array<[string, ResolvedPlugin]> = [];
    for (const [name, resolved] of pending) {
      const dependencies = [
        ...(resolved.plugin.dependencies ?? []),
        ...(CORE_PLUGIN_BOOT_DEPENDENCIES.get(name) ?? []),
      ];
      if (
        !dependencies.some(
          (dependency) =>
            pending.has(dependency) && !registered.has(dependency),
        )
      ) {
        ready.push([name, resolved]);
      }
    }

    const wave = ready.length > 0 ? ready : Array.from(pending);
    await Promise.all(
      wave.map(([name, resolved]) => registerOne(name, resolved)),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function initializeBlockingCoreRuntimeForBoot(args: {
  blockDeferredPluginImports: boolean;
  runtime: AgentRuntime;
  resolvedPlugins: ResolvedPlugin[];
  requiredPluginNames: ReadonlySet<string>;
  waitForBlockingEnvironment: () => Promise<void>;
  initializeCoreRuntime: () => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (args.blockDeferredPluginImports) {
    await args.waitForBlockingEnvironment();
  }
  args.abortSignal?.throwIfAborted();
  await preregisterCorePluginsInDependencyWaves({
    runtime: args.runtime,
    resolvedPlugins: args.resolvedPlugins,
    alreadyPreRegistered: new Set<string>([
      "@elizaos/plugin-sql",
      "@elizaos/plugin-local-inference",
    ]),
    requiredPluginNames: args.requiredPluginNames,
    label: "blocking",
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  });
  args.abortSignal?.throwIfAborted();
  await args.initializeCoreRuntime();
}
