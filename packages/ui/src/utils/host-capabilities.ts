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

interface NavigatorLike {
  userAgent?: string;
}

declare const navigator: NavigatorLike | undefined;

export function detectUiHostCapabilities(): UiHostCapabilities {
  // Cloudflare Workers — short-lived per request, no persistent process.
  if (
    typeof navigator !== "undefined" &&
    typeof navigator?.userAgent === "string" &&
    navigator.userAgent.includes("Cloudflare-Workers")
  ) {
    return {
      longRunning: false,
      isMobile: false,
      isBrowser: false,
      label: "Cloudflare Worker",
    };
  }

  // Capacitor (iOS / Android). `longRunning` is conditional on a registered
  // BackgroundRunner plugin: without it, the JS context suspends within
  // seconds of backgrounding. We probe the plugin instance rather than
  // trusting a build-time flag.
  const capacitor: unknown = Reflect.get(globalThis, "Capacitor");
  if (capacitor && typeof capacitor === "object") {
    const plugins: unknown = Reflect.get(capacitor as object, "Plugins");
    const bgRunner: unknown =
      plugins && typeof plugins === "object"
        ? Reflect.get(plugins as object, "BackgroundRunner")
        : undefined;
    const hasBgRunner = typeof bgRunner === "object" && bgRunner !== null;
    return {
      longRunning: hasBgRunner,
      isMobile: true,
      isBrowser: false,
      label: hasBgRunner ? "Mobile" : "Mobile (foreground-only)",
    };
  }

  // Browser without Capacitor — pure web. Tabs can be discarded by the OS.
  if (typeof window !== "undefined" && typeof process === "undefined") {
    return {
      longRunning: false,
      isMobile: false,
      isBrowser: true,
      label: "Browser",
    };
  }

  // Node — server / desktop. Stays alive.
  return {
    longRunning: true,
    isMobile: false,
    isBrowser: false,
    label: "Desktop",
  };
}

/**
 * Short cadence threshold below which mobile and browser hosts cannot
 * keep up. iOS/Android background-runner wakes are bounded to ~15 minutes
 * (WorkManager floor; BGTaskScheduler is opportunistic and typically wakes
 * less often). Anything tighter than this is misleading on those hosts.
 */
export const SHORT_INTERVAL_THRESHOLD_MS = 15 * 60 * 1000;

export interface IntervalHostWarning {
  /** Translation-ready message body. */
  message: string;
  /** Whether to surface the warning at all. */
  show: boolean;
}

export function intervalHostWarning(
  host: UiHostCapabilities,
  intervalMs: number,
): IntervalHostWarning {
  if (intervalMs >= SHORT_INTERVAL_THRESHOLD_MS) {
    return { show: false, message: "" };
  }
  if (host.isMobile) {
    return {
      show: true,
      message:
        "Mobile devices can only check at most every 15 minutes. This trigger will fire at the host's minimum cadence (~15 min).",
    };
  }
  if (host.isBrowser) {
    return {
      show: true,
      message:
        "Browser tabs can be discarded by the OS. This trigger may stop firing when the tab is hidden.",
    };
  }
  return { show: false, message: "" };
}
