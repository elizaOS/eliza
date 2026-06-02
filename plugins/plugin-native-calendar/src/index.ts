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
