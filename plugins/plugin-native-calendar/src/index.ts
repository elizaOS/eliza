import { registerPlugin } from "@capacitor/core";
import type { AppleCalendarPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.AppleCalendarWeb());

export const AppleCalendar = registerPlugin<AppleCalendarPlugin>(
  "AppleCalendar",
  {
    web: loadWeb,
  },
);
