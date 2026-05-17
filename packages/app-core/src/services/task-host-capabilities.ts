/**
 * Runtime probe for the set of `TaskExecutionProfile` values the current
 * host can satisfy.
 *
 * Consumed by `plugins/plugin-lifeops/src/lifeops/scheduled-task/runtime-
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
 * Layering: this module lives in app-core (infrastructure) so the
 * scheduled-task runner in app-lifeops can call it without inverting the
 * dependency direction. It probes `globalThis.Capacitor` so the same
 * code path works in both the iOS-local-agent-kernel (runs in the same
 * WebView) and on a Node desktop runtime (no Capacitor — falls through
 * to "all four available").
 */

import type { IAgentRuntime } from "@elizaos/core";

/**
 * Mirrors `TaskExecutionProfile` from `plugins/plugin-lifeops/src/lifeops/
 * scheduled-task/types.ts`. Re-declared here to avoid an import inversion
 * (app-core must not depend on app-lifeops). Kept in sync via the test at
 * `plugins/plugin-lifeops/src/lifeops/scheduled-task/runner.test.ts` which
 * imports both and asserts structural compatibility.
 */
export type TaskExecutionProfileForHost =
  | "foreground"
  | "bg-light-30s"
  | "bg-heavy-fgs"
  | "notify-only";

interface CapacitorPluginsLike {
  BackgroundRunner?: unknown;
  ElizaTasks?: unknown;
}

interface CapacitorGlobalLike {
  Plugins?: CapacitorPluginsLike;
  isNativePlatform?: () => boolean;
}

/**
 * Resolves the host's currently-available execution profiles. Pure
 * function of `globalThis.Capacitor` + `runtime.getSetting`; safe to call
 * on every fire.
 */
export function getHostExecutionCapabilities(
  runtime: IAgentRuntime,
): ReadonlySet<TaskExecutionProfileForHost> {
  const profiles = new Set<TaskExecutionProfileForHost>();
  // Foreground + notify-only are always available.
  profiles.add("foreground");
  profiles.add("notify-only");

  const capacitor: unknown = Reflect.get(globalThis, "Capacitor");
  const isCapacitor =
    typeof capacitor === "object" &&
    capacitor !== null &&
    typeof (capacitor as CapacitorGlobalLike).isNativePlatform === "function" &&
    (capacitor as CapacitorGlobalLike).isNativePlatform?.() === true;

  if (!isCapacitor) {
    // Node desktop or pure browser. Desktop hosts every profile; pure
    // browser cannot keep a process alive but is rare in production. We
    // err toward "capable" because the Node path is the dominant one;
    // the browser-only case is covered by the engine's own activation
    // gate (`assertHostSupports` refuses `requiresLongRunning` on pure
    // browsers).
    profiles.add("bg-light-30s");
    profiles.add("bg-heavy-fgs");
    return profiles;
  }

  const plugins = (capacitor as CapacitorGlobalLike).Plugins;
  const hasBackgroundRunner =
    plugins != null &&
    typeof plugins === "object" &&
    plugins.BackgroundRunner != null &&
    typeof plugins.BackgroundRunner === "object";
  if (hasBackgroundRunner) {
    profiles.add("bg-light-30s");
  }

  // iOS: ElizaTasksPlugin registers `ai.eliza.tasks.processing`
  // (BGProcessingTask). Its presence means we can ask for a long
  // background window on charger+idle.
  const hasElizaTasks =
    plugins != null &&
    typeof plugins === "object" &&
    plugins.ElizaTasks != null &&
    typeof plugins.ElizaTasks === "object";

  // Android: ElizaAgentService sets ELIZA_HOST_FGS_ACTIVE to "1" while
  // the foreground service is running. The runtime exposes this via
  // `getSetting` (read-through to env / settings store).
  let fgsActive = false;
  const getSetting = (runtime as { getSetting?: (k: string) => unknown })
    .getSetting;
  if (typeof getSetting === "function") {
    const raw = getSetting.call(runtime, "ELIZA_HOST_FGS_ACTIVE");
    fgsActive = raw === "1" || raw === true;
  }

  if (hasElizaTasks || fgsActive) {
    profiles.add("bg-heavy-fgs");
  }

  return profiles;
}

/**
 * Snapshot helper for diagnostics — returns the same data as
 * `getHostExecutionCapabilities` but as a structured object that's
 * easier to serialize into `/api/health` extensions.
 */
export function describeHostExecutionCapabilities(runtime: IAgentRuntime): {
  profiles: TaskExecutionProfileForHost[];
  isCapacitor: boolean;
  hasBackgroundRunner: boolean;
  hasElizaTasksPlugin: boolean;
  fgsActive: boolean;
} {
  const profiles = Array.from(getHostExecutionCapabilities(runtime));
  const capacitor: unknown = Reflect.get(globalThis, "Capacitor");
  const isCapacitor =
    typeof capacitor === "object" &&
    capacitor !== null &&
    typeof (capacitor as CapacitorGlobalLike).isNativePlatform === "function" &&
    (capacitor as CapacitorGlobalLike).isNativePlatform?.() === true;
  const plugins =
    isCapacitor && capacitor != null
      ? (capacitor as CapacitorGlobalLike).Plugins
      : undefined;
  const hasBackgroundRunner =
    plugins != null &&
    typeof plugins === "object" &&
    plugins.BackgroundRunner != null;
  const hasElizaTasksPlugin =
    plugins != null &&
    typeof plugins === "object" &&
    plugins.ElizaTasks != null;
  const getSetting = (runtime as { getSetting?: (k: string) => unknown })
    .getSetting;
  const raw =
    typeof getSetting === "function"
      ? getSetting.call(runtime, "ELIZA_HOST_FGS_ACTIVE")
      : undefined;
  return {
    profiles,
    isCapacitor,
    hasBackgroundRunner: Boolean(hasBackgroundRunner),
    hasElizaTasksPlugin: Boolean(hasElizaTasksPlugin),
    fgsActive: raw === "1" || raw === true,
  };
}
