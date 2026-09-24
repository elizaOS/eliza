/**
 * Folds plugin Settings mutations into the live runtime's getSetting surface.
 *
 * Plugin catalog `isSet` reads `process.env`, but connector plugins (Discord,
 * Telegram, …) resolve credentials via `runtime.getSetting()`, which never
 * falls through to process.env. Writing only process.env / config.env made the
 * UI look configured while hot-loaded plugins still saw an empty token.
 * Callers must invoke this before applyPluginRuntimeMutation / plugin reload
 * so init() and service constructors observe the same values the catalog does.
 *
 * Sources must be agent-scoped (PUT body, entry.config, config.env). Do not
 * hydrate from bare process.env — that can copy host secrets across agents in
 * a shared process (#18713).
 */
import type { AgentRuntime } from "@elizaos/core";

export type BridgedPluginParam = {
  key: string;
  sensitive?: boolean;
};

type RuntimeSettingWriter = Pick<AgentRuntime, "setSetting">;

export type FoldPluginParamsOptions = {
  /**
   * Reject host/step-up keys (ELIZA_API_TOKEN, DATABASE_URL, …). Required on
   * write paths; clearing a key with null/blank still runs so disable can
   * revoke previously folded credentials.
   */
  isBlockedKey?: (key: string) => boolean;
};

/**
 * Collect declared plugin params from agent-owned config only (entry.config
 * wins over config.env). Missing keys are omitted — callers should not clear
 * on enable just because a param was never saved.
 */
export function collectAgentScopedPluginParamValues(
  parameters: readonly BridgedPluginParam[],
  sources: {
    entryConfig?: Record<string, unknown> | null;
    configEnv?: Record<string, unknown> | null;
  },
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of parameters) {
    const fromEntry = sources.entryConfig?.[param.key];
    const fromEnv = sources.configEnv?.[param.key];
    const raw =
      typeof fromEntry === "string" && fromEntry.trim()
        ? fromEntry.trim()
        : typeof fromEnv === "string" && fromEnv.trim()
          ? fromEnv.trim()
          : undefined;
    if (raw !== undefined) {
      values[param.key] = raw;
    }
  }
  return values;
}

/**
 * Build a clear-map for every declared param (disable / revoke path).
 */
export function clearPluginParamValues(
  parameters: readonly BridgedPluginParam[],
): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const param of parameters) {
    values[param.key] = undefined;
  }
  return values;
}

/**
 * Writes (or clears) plugin parameter values onto `runtime.setSetting`.
 *
 * Only keys present in `values` are touched. Blank/undefined clears.
 * Non-empty writes of blocked keys are skipped.
 */
export function bridgePluginParamsToRuntime(
  runtime: RuntimeSettingWriter | null | undefined,
  parameters: readonly BridgedPluginParam[],
  values: Readonly<Record<string, string | undefined>>,
  options: FoldPluginParamsOptions = {},
): void {
  if (!runtime || typeof runtime.setSetting !== "function") {
    return;
  }

  const { isBlockedKey } = options;

  for (const param of parameters) {
    if (!Object.hasOwn(values, param.key)) {
      continue;
    }
    const raw = values[param.key];
    const secret = Boolean(param.sensitive);
    if (typeof raw === "string" && raw.trim()) {
      if (isBlockedKey?.(param.key)) {
        continue;
      }
      runtime.setSetting(param.key, raw.trim(), secret);
      continue;
    }
    runtime.setSetting(param.key, null, secret);
  }
}
