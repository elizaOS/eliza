import type { AgentRuntime, ServiceRoutingConfig } from "@elizaos/core";
export interface AppCoreAccountPoolCredentialsOptions {
    activeBackend?: string | null | undefined;
    accountStrategies?: Record<string, unknown>;
    serviceRouting?: ServiceRoutingConfig | null | undefined;
}
export interface AppCoreRuntimeHooks {
    hydrateWalletKeysFromNodePlatformSecureStore: () => Promise<void> | void;
    runVaultBootstrap: () => Promise<{
        migrated: number;
        failed: unknown[];
    }>;
    sharedVault: () => unknown;
    getDefaultAccountPool: () => unknown;
    applyAccountPoolApiCredentials: (options?: AppCoreAccountPoolCredentialsOptions) => Promise<void> | void;
    startAccountPoolKeepAlive: () => void;
    ensureLocalInferenceHandler?: (runtime: AgentRuntime) => Promise<void> | void;
}
export declare function registerAppCoreRuntimeHooks(hooks: AppCoreRuntimeHooks): void;
export declare function getAppCoreRuntimeHooks(): AppCoreRuntimeHooks | null;
//# sourceMappingURL=app-core-runtime-hooks.d.ts.map