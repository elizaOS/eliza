import { registerPlugin } from "@capacitor/core";
import type { AndroidRemindersPlugin } from "./android-definitions.js";

export type * from "./android-definitions.js";

/** Explicit host registration. No Apple API mapping or simulated web implementation. */
export function registerAndroidReminders(
  pluginName: string,
): AndroidRemindersPlugin {
  if (
    typeof pluginName !== "string" ||
    !pluginName.trim() ||
    pluginName !== pluginName.trim()
  ) {
    throw new Error("A native Reminders plugin name is required");
  }
  return registerPlugin<AndroidRemindersPlugin>(pluginName);
}
