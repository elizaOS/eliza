import { detectHostCapabilities, type HostCapabilities } from "@elizaos/shared";

export type UiHostCapabilities = Pick<
  HostCapabilities,
  "longRunning" | "isMobile" | "isBrowser" | "label"
>;

export function detectUiHostCapabilities(): UiHostCapabilities {
  const { longRunning, isMobile, isBrowser, label } = detectHostCapabilities();
  return { longRunning, isMobile, isBrowser, label };
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
