import "@elizaos/shared";
import {
  type BootElizaRuntimeOptions,
  CUSTOM_PLUGINS_DIRNAME,
  resolvePackageEntry,
  type StartElizaOptions,
  scanDropInPlugins,
  applyCloudConfigToEnv as upstreamApplyCloudConfigToEnv,
  bootElizaRuntime as upstreamBootElizaRuntime,
  collectPluginNames as upstreamCollectPluginNames,
  shutdownRuntime as upstreamShutdownRuntime,
  startEliza as upstreamStartEliza,
} from "@elizaos/agent";

export { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map.js";
export { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins };

type EmbeddingProgressCallback = (
  phase: EmbeddingWarmupPhase,
  detail?: string,
) => void;

import { type EmbeddingWarmupPhase } from "./startup-overlay.js";
export declare const shutdownRuntime: typeof upstreamShutdownRuntime;
export declare function collectPluginNames(
  ...args: Parameters<typeof upstreamCollectPluginNames>
): ReturnType<typeof upstreamCollectPluginNames>;
export declare function applyCloudConfigToEnv(
  ...args: Parameters<typeof upstreamApplyCloudConfigToEnv>
): ReturnType<typeof upstreamApplyCloudConfigToEnv>;
export interface BootElizaRuntimeOptionsExt extends BootElizaRuntimeOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}
export declare function bootElizaRuntime(
  opts?: BootElizaRuntimeOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamBootElizaRuntime>>>;
export interface StartElizaOptionsExt extends StartElizaOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}
export declare function attemptPgliteAutoReset(
  err: unknown,
): Promise<string | null>;
export declare function getPgliteRecoveryRetrySkipPlugins(): string[];
export declare function startEliza(
  options?: StartElizaOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>>;
//# sourceMappingURL=eliza.d.ts.map
