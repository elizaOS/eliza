/**
 * Capacitor entry point for the AppleCalendar bridge: registers the plugin
 * object whose native implementation is the Swift EventKit bridge under
 * `ios/`, lazy-loading the web fallback only when no native implementation
 * is registered so browser bundles avoid pulling in native-only code.
 */
import { registerPlugin } from "@capacitor/core";
import type { AppleCalendarPlugin } from "./definitions";

export * from "./definitions";
export * from "./macos-bridge-policy";

const loadWeb = () => import("./web").then((m) => new m.AppleCalendarWeb());

export const AppleCalendar = registerPlugin<AppleCalendarPlugin>(
  "AppleCalendar",
  {
    web: loadWeb,
  },
);
