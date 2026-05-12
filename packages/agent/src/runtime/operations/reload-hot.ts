/**
 * Hot reload strategy.
 *
 * The fast path. Used when the change can be applied by mutating env vars and
 * (best-effort) notifying plugins via their `applyConfig` lifecycle hook —
 * no plugin reload, no service teardown, no full runtime swap.
 *
 * Bounded ~100ms. Idempotent: calling twice with the same intent is safe;
 * env vars settle to the same values, notifications are best-effort.
 *
 * The strategy delegates env mutation to a caller-supplied `applyProviderEnv`
 * which wraps the existing onboarding env-pump (`applyOnboardingConnectionConfig`
 * + `createProviderSwitchConnection`). The plugin notify step iterates the
 * runtime's plugins and invokes `plugin.applyConfig` when present; that hook
 * is the one defined on the elizaOS Plugin contract for config-only updates.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { formatErrorWithStack } from "@elizaos/shared";
import type { SecretsManager } from "@elizaos/vault";
import type {
  OperationIntent,
  OperationPhase,
  ProviderSwitchIntent,
  ReloadContext,
  ReloadStrategy,
} from "./types.ts";
import {
  defaultSecretsManager,
  resolveProviderApiKey,
} from "./vault-bridge.ts";

export interface HotStrategyDeps {
  /**
   * Apply env-var / config mutations for a provider switch. Defaults wrap the
   * existing onboarding env-pump. The wrapper must be idempotent: same intent
   * in → same env state out.
   */
  applyProviderEnv: (intent: ProviderSwitchIntent) => Promise<void>;
  /**
   * Best-effort plugin notify. Called after env mutation. Implementations
   * iterate `runtime.plugins` and call each plugin's `applyConfig` hook (the
   * elizaOS Plugin contract's config-only update path). Failures here are
   * logged and surfaced as a warning phase, but do NOT fail the operation —
   * env was already applied and plugins will pick up the new values on
   * their next request.
   */
  notifyConfigChanged: (
    runtime: AgentRuntime,
    change: { kind: string; detail?: Record<string, unknown> },
  ) => Promise<void>;
}

function buildPhase(
  name: OperationPhase["name"],
  status: OperationPhase["status"],
  startedAt: number,
  finishedAt: number,
  extra: Pick<OperationPhase, "error" | "detail"> = {},
): OperationPhase {
  return {
    name,
    status,
    startedAt,
    finishedAt,
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

function describeIntent(intent: OperationIntent): {
  kind: string;
  detail: Record<string, unknown>;
} {
  switch (intent.kind) {
    case "provider-switch":
      return {
        kind: "provider-switch",
        detail: {
          provider: intent.provider,
          ...(intent.primaryModel ? { primaryModel: intent.primaryModel } : {}),
          ...(intent.apiKeyRef ? { apiKeyChanged: true } : {}),
        },
      };
    case "config-reload":
      return {
        kind: "config-reload",
        detail: {
          ...(intent.changedPaths
            ? { changedPaths: [...intent.changedPaths] }
            : {}),
        },
      };
    case "plugin-enable":
    case "plugin-disable":
      return {
        kind: intent.kind,
        detail: { pluginId: intent.pluginId },
      };
    case "restart":
      return { kind: "restart", detail: { reason: intent.reason } };
  }
}

/**
 * Default env-pump wrapper. Lazy-imports the onboarding env-pump to keep the
 * dependency graph clean (the operations module sits below the api module
 * in the layering, but the env-pump genuinely owns the canonical mutation).
 *
 * The intent carries `apiKeyRef` (a vault key), not the secret itself. The
 * vault is consulted here on every hot reload and only the resolved
 * plaintext is passed downstream to `createProviderSwitchConnection`.
 */
function makeDefaultApplyProviderEnv(
  secrets: SecretsManager,
): (intent: ProviderSwitchIntent) => Promise<void> {
  return async (intent: ProviderSwitchIntent): Promise<void> => {
    const { applyOnboardingConnectionConfig, createProviderSwitchConnection } =
      await import("../../api/provider-switch-config.ts");
    const { loadElizaConfig, saveElizaConfig } = await import(
      "../../config/config.ts"
    );

    const apiKey = await resolveProviderApiKey({
      secrets,
      apiKeyRef: intent.apiKeyRef,
      caller: "runtime-ops:reload-hot",
    });

    const connection = createProviderSwitchConnection({
      provider: intent.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(intent.primaryModel ? { primaryModel: intent.primaryModel } : {}),
    });
    if (!connection) {
      throw new Error(
        `[runtime-ops] hot reload: invalid provider "${intent.provider}"`,
      );
    }

    const config = loadElizaConfig();
    await applyOnboardingConnectionConfig(config, connection);
    saveElizaConfig(config);
  };
}

/**
 * Default plugin notify. Iterates the runtime's plugins and calls
 * `plugin.applyConfig` when defined. The hook receives the plugin's own
 * config record (already attached to the plugin instance) and the runtime —
 * matching the elizaOS Plugin contract.
 *
 * If no plugin defines `applyConfig`, this is a no-op log: env has been set
 * and plugins will resolve the new values on their next call into the
 * provider client.
 */
async function defaultNotifyConfigChanged(
  runtime: AgentRuntime,
  change: { kind: string; detail?: Record<string, unknown> },
): Promise<void> {
  const plugins: readonly Plugin[] = runtime.plugins ?? [];
  let notified = 0;
  let failures = 0;

  for (const plugin of plugins) {
    if (typeof plugin.applyConfig !== "function") continue;
    try {
      const pluginConfig: Record<string, string> = {};
      if (plugin.config) {
        for (const [key, value] of Object.entries(plugin.config)) {
          if (value === null || value === undefined) continue;
          pluginConfig[key] = String(value);
        }
      }
      await plugin.applyConfig(pluginConfig, runtime);
      notified += 1;
    } catch (err) {
      failures += 1;
      logger.warn(
        `[runtime-ops] hot reload: plugin "${plugin.name}" applyConfig failed: ${formatErrorWithStack(err)}`,
      );
    }
  }

  if (notified === 0 && failures === 0) {
    logger.info(
      `[runtime-ops] no plugin reload hook found — env applied, plugins will pick up on next request (change=${change.kind})`,
    );
    return;
  }

  logger.info(
    `[runtime-ops] hot reload: notified ${notified} plugin(s), ${failures} failure(s) (change=${change.kind})`,
  );
}

export function createHotStrategy(
  opts: Partial<HotStrategyDeps> & { secrets?: SecretsManager } = {},
): ReloadStrategy {
  const secrets = opts.secrets ?? defaultSecretsManager();
  const applyProviderEnv =
    opts.applyProviderEnv ?? makeDefaultApplyProviderEnv(secrets);
  const notifyConfigChanged =
    opts.notifyConfigChanged ?? defaultNotifyConfigChanged;

  return {
    tier: "hot",
    async apply(ctx: ReloadContext): Promise<AgentRuntime> {
      const envStarted = Date.now();
      if (ctx.intent.kind !== "provider-switch") {
        // Other hot-eligible intents (config-reload over env./vars./models.)
        // flow through the plugin notify step only — env was already mutated
        // by whoever scheduled the operation (e.g. the config writer).
        await ctx.reportPhase(
          buildPhase("apply-env", "skipped", envStarted, Date.now(), {
            detail: { reason: `intent=${ctx.intent.kind}` },
          }),
        );
      } else {
        try {
          await applyProviderEnv(ctx.intent);
          await ctx.reportPhase(
            buildPhase("apply-env", "succeeded", envStarted, Date.now(), {
              detail: { provider: ctx.intent.provider },
            }),
          );
        } catch (err) {
          await ctx.reportPhase(
            buildPhase("apply-env", "failed", envStarted, Date.now(), {
              error: { message: formatErrorWithStack(err) },
            }),
          );
          throw err;
        }
      }

      const notifyStarted = Date.now();
      const change = describeIntent(ctx.intent);
      try {
        await notifyConfigChanged(ctx.runtime, change);
        await ctx.reportPhase(
          buildPhase("notify-plugins", "succeeded", notifyStarted, Date.now(), {
            detail: change.detail,
          }),
        );
      } catch (err) {
        // Best-effort: env is already applied, so we surface this as a failed
        // phase with a warning but do NOT throw — the operation still
        // succeeds at the manager level.
        logger.warn(
          `[runtime-ops] hot reload: notify-plugins failed (env already applied): ${formatErrorWithStack(err)}`,
        );
        await ctx.reportPhase(
          buildPhase("notify-plugins", "failed", notifyStarted, Date.now(), {
            error: { message: formatErrorWithStack(err) },
          }),
        );
      }

      return ctx.runtime;
    },
  };
}
