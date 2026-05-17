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
export type TaskExecutionProfileForHost = "foreground" | "bg-light-30s" | "bg-heavy-fgs" | "notify-only";
/**
 * Resolves the host's currently-available execution profiles. Pure
 * function of `globalThis.Capacitor` + `runtime.getSetting`; safe to call
 * on every fire.
 */
export declare function getHostExecutionCapabilities(runtime: IAgentRuntime): ReadonlySet<TaskExecutionProfileForHost>;
/**
 * Snapshot helper for diagnostics — returns the same data as
 * `getHostExecutionCapabilities` but as a structured object that's
 * easier to serialize into `/api/health` extensions.
 */
export declare function describeHostExecutionCapabilities(runtime: IAgentRuntime): {
    profiles: TaskExecutionProfileForHost[];
    isCapacitor: boolean;
    hasBackgroundRunner: boolean;
    hasElizaTasksPlugin: boolean;
    fgsActive: boolean;
};
//# sourceMappingURL=task-host-capabilities.d.ts.map