import { registerPlugin } from "@capacitor/core";
import type { AndroidCalendarPlugin } from "./android-definitions";

export type * from "./android-definitions";

/** The host supplies the name of its annotated native subclass. No automatic registration or web simulation. */
export function registerAndroidCalendar(
  pluginName: string,
): AndroidCalendarPlugin {
  if (
    typeof pluginName !== "string" ||
    !pluginName.trim() ||
    pluginName !== pluginName.trim()
  )
    throw new Error("A native Calendar plugin name is required");
  return registerPlugin<AndroidCalendarPlugin>(pluginName);
}
