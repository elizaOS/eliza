/** Provides a reactive, privacy-safe snapshot of the device wake-word opt-in. */

import * as React from "react";
import {
  loadWakeWordEnabled,
  subscribeWakeWordEnabled,
} from "../state/persistence";

const getServerSnapshot = (): boolean => false;

/** Read the wake-word master switch and update immediately in the same window. */
export function useWakeWordEnabledPreference(): boolean {
  return React.useSyncExternalStore(
    subscribeWakeWordEnabled,
    loadWakeWordEnabled,
    getServerSnapshot,
  );
}
