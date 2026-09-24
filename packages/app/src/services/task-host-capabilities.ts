/**
 * Runtime probe for the set of `TaskExecutionProfile` values the current
 * host can satisfy.
 *
 * Consumed by `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-
 * wiring.ts` when constructing the `ScheduledTaskRunner`. The runner uses
 * the result post-fire-claim to substitute incapable profiles to
 * `notify-only` (a local notification the user taps to resume the work
 * in foreground).
 *
 * Detection rules:
 *  - `foreground`:    always available (every host can run a task while
 *                     the app is in front).
 *  - `notify-only`:   always available (the local-notification channel
 *                     fires even on suspended Capacitor apps).
 *  - `bg-light-30s`:  Capacitor host with a registered BackgroundRunner
 *                     plugin (probe via `globalThis.Capacitor.Plugins.
 *                     BackgroundRunner`), OR Node desktop.
 *  - `bg-heavy-fgs`:  Android FGS alive (we read `runtime.getSetting(
 *                     "ELIZA_HOST_FGS_ACTIVE")` which the Java FGS sets
 *                     to "1" while running) OR Node desktop. iOS gets it
 *                     when `BGProcessingTask` identifiers are present
 *                     (probed via the ElizaTasks plugin handle on the
 *                     Capacitor global).
 *
 * Layering: this module lives in app (infrastructure) so the
 * scheduled-task runner in app-lifeops can call it without inverting the
 * dependency direction. It probes `globalThis.Capacitor` so the same
 * code path works in both the iOS-local-agent-kernel (runs in the same
 * WebView) and on a Node desktop runtime (no Capacitor — falls through
 * to "all four available").
 */
import { type IAgentRuntime } from "@elizaos/core";
import { type TaskExecutionProfile } from "@elizaos/core/contracts/scheduled-task-execution";

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
