import type { AgentRuntime, ServiceRoutingConfig } from "@elizaos/core";

export interface AppCoreAccountPoolCredentialsOptions {
  activeBackend?: string | null | undefined;
  accountStrategies?: Record<string, unknown>;
  serviceRouting?: ServiceRoutingConfig | null | undefined;
}

export interface AppCoreRuntimeHooks {
  hydrateWalletKeysFromNodePlatformSecureStore: () => Promise<void> | void;
  runVaultBootstrap: () => Promise<{ migrated: number; failed: unknown[] }>;
  sharedVault: () => unknown;
  getDefaultAccountPool: () => unknown;
  applyAccountPoolApiCredentials: (
    options?: AppCoreAccountPoolCredentialsOptions,
  ) => Promise<void> | void;
  startAccountPoolKeepAlive: () => void;
  ensureLocalInferenceHandler?: (runtime: AgentRuntime) => Promise<void> | void;
}

const APP_CORE_RUNTIME_HOOKS = Symbol.for("elizaos.app-core.runtime-hooks");

type AppCoreRuntimeHooksGlobal = typeof globalThis & {
  [APP_CORE_RUNTIME_HOOKS]?: AppCoreRuntimeHooks;
};

function hooksGlobal(): AppCoreRuntimeHooksGlobal {
  return globalThis as AppCoreRuntimeHooksGlobal;
}

export function registerAppCoreRuntimeHooks(hooks: AppCoreRuntimeHooks): void {
  hooksGlobal()[APP_CORE_RUNTIME_HOOKS] = hooks;
}

export function getAppCoreRuntimeHooks(): AppCoreRuntimeHooks | null {
  return hooksGlobal()[APP_CORE_RUNTIME_HOOKS] ?? null;
}
