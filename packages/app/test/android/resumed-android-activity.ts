/**
 * Extracts the single resumed Android activity from `dumpsys activity
 * activities` so device assertions cannot pass on background task history or
 * Custom Tabs service connections.
 */

import { APP_ID } from "../../scripts/lib/android-device.mjs";

const RESUMED_ACTIVITY_LINE =
  /^\s*(?:topResumedActivity|mResumedActivity)\s*[:=]\s*(.*)$/m;

export const ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY = new RegExp(
  `^(?:com\\.android\\.chrome/|${APP_ID.replace(/\./g, "\\.")}\\/com\\.capacitorjs\\.plugins\\.browser\\.BrowserControllerActivity$)`,
);

/** Returns the package/activity component from the bounded resumed line. */
export function resumedAndroidActivityComponent(
  activityDump: string,
): string | null {
  const resumedLine = activityDump.match(RESUMED_ACTIVITY_LINE)?.[1];
  if (!resumedLine) return null;
  return resumedLine.match(/([A-Za-z0-9._$]+\/[.A-Za-z0-9_$]+)/)?.[1] ?? null;
}
