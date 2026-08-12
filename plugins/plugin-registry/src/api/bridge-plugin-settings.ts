/**
 * Bridges plugin Settings mutations into the live runtime's getSetting surface.
 *
 * Plugin catalog `isSet` reads `process.env`, but connector plugins (Discord,
 * Telegram, …) resolve credentials via `runtime.getSetting()`, which never
 * falls through to process.env. Writing only process.env / config.env made the
 * UI look configured while hot-loaded plugins still saw an empty token.
 * Callers must invoke this before applyPluginRuntimeMutation / plugin reload
 * so init() and service constructors observe the same values the catalog does.
 */
import type { AgentRuntime } from "@elizaos/core";

export type BridgedPluginParam = {
  key: string;
  sensitive?: boolean;
};

type RuntimeSettingWriter = Pick<AgentRuntime, "setSetting">;

/**
 * Writes (or clears) plugin parameter values onto `runtime.setSetting`.
 *
 * When `values` is provided, only those keys are updated — blank/missing
 * values clear the setting. When omitted, every parameter is hydrated from
 * `process.env` (used on enable so a previously saved token becomes visible
 * to getSetting before the plugin reloads).
 */
export function bridgePluginParamsToRuntime(
  runtime: RuntimeSettingWriter | null | undefined,
  parameters: readonly BridgedPluginParam[],
  values?: Readonly<Record<string, string | undefined>>,
): void {
  if (!runtime || typeof runtime.setSetting !== "function") {
    return;
  }

  for (const param of parameters) {
    if (values && !Object.hasOwn(values, param.key)) {
      continue;
    }
    const raw = values ? values[param.key] : process.env[param.key];
    const secret = Boolean(param.sensitive);
    if (typeof raw === "string" && raw.trim()) {
      runtime.setSetting(param.key, raw.trim(), secret);
      continue;
    }
    if (values) {
      runtime.setSetting(param.key, null, secret);
    }
  }
}
