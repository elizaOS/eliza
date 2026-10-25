/** Derives the scheduler's default execution profiles from native host evidence. */

import type { TaskExecutionProfile } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";

interface CapacitorPluginsLike {
  BackgroundRunner?: unknown;
  ElizaTasks?: unknown;
}
interface CapacitorGlobalLike {
  Plugins?: CapacitorPluginsLike;
  isNativePlatform?: () => boolean;
}

/** Read one host snapshot so scheduler decisions and diagnostics agree. */
export function describeHostExecutionCapabilities(runtime: IAgentRuntime): {
  profiles: TaskExecutionProfile[];
  isCapacitor: boolean;
  hasBackgroundRunner: boolean;
  hasElizaTasksPlugin: boolean;
  fgsActive: boolean;
} {
  const capacitor = Reflect.get(globalThis, "Capacitor") as
    | CapacitorGlobalLike
    | undefined;
  const isCapacitor = capacitor?.isNativePlatform?.() === true;
  const plugins = isCapacitor ? capacitor?.Plugins : undefined;
  const hasBackgroundRunner =
    plugins?.BackgroundRunner !== null &&
    typeof plugins?.BackgroundRunner === "object";
  const hasElizaTasksPlugin =
    plugins?.ElizaTasks !== null && typeof plugins?.ElizaTasks === "object";
  const raw = runtime.getSetting("ELIZA_HOST_FGS_ACTIVE");
  const fgsActive = raw === "1" || raw === true;
  const isNode =
    !isCapacitor &&
    typeof process !== "undefined" &&
    Boolean(process.versions?.node);
  const profiles: TaskExecutionProfile[] = ["foreground", "notify-only"];
  if (isNode || hasBackgroundRunner) profiles.push("bg-light-30s");
  if (isNode || (isCapacitor && (hasElizaTasksPlugin || fgsActive)))
    profiles.push("bg-heavy-fgs");
  return {
    profiles,
    isCapacitor,
    hasBackgroundRunner,
    hasElizaTasksPlugin,
    fgsActive,
  };
}

export function getHostExecutionCapabilities(
  runtime: IAgentRuntime,
): ReadonlySet<TaskExecutionProfile> {
  return new Set(describeHostExecutionCapabilities(runtime).profiles);
}
