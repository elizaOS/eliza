/**
 * host-capabilities.ts — UI-side mirror of the workflow engine's host
 * capability detection.
 *
 * The canonical truth lives in `@elizaos/plugin-workflow/src/utils/host-
 * capabilities.ts`. This module duplicates the detection because the UI
 * package must not depend on a plugin runtime (presentation → infrastructure
 * is a layer-direction violation), and the detection is a tiny pure check.
 *
 * Keep the two in sync. The label strings here are user-facing copy and
 * should match the ones in the plugin so users see consistent wording
 * across engine-emitted errors and UI banners.
 */
export interface UiHostCapabilities {
  /** Host process stays alive across schedule firings. */
  longRunning: boolean;
  /** True when running inside a Capacitor (iOS/Android) shell. */
  isMobile: boolean;
  /** True for a pure browser tab (no Capacitor, no Node). */
  isBrowser: boolean;
  /** Human-readable host label for banners and warnings. */
  label: string;
}
export declare function detectUiHostCapabilities(): UiHostCapabilities;
/**
 * Short cadence threshold below which mobile and browser hosts cannot
 * keep up. iOS/Android background-runner wakes are bounded to ~15 minutes
 * (WorkManager floor; BGTaskScheduler is opportunistic and typically wakes
 * less often). Anything tighter than this is misleading on those hosts.
 */
export declare const SHORT_INTERVAL_THRESHOLD_MS: number;
export interface IntervalHostWarning {
  /** Translation-ready message body. */
  message: string;
  /** Whether to surface the warning at all. */
  show: boolean;
}
export declare function intervalHostWarning(
  host: UiHostCapabilities,
  intervalMs: number,
): IntervalHostWarning;
//# sourceMappingURL=host-capabilities.d.ts.map
