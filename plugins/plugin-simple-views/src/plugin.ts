/**
 * Runtime declaration for the developer-only Notes and Simple Calendar
 * workbench. It contributes two agent-drivable views backed by one durable
 * service while delegating navigation and layout to the shared VIEWS system.
 */

import type { Plugin } from "@elizaos/core";
import { CALENDAR_CAPABILITIES, NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { simpleViewsRoutes } from "./routes.js";
import { SimpleViewsService } from "./service.js";

export const simpleViewsPlugin: Plugin = {
  name: "@elizaos/plugin-simple-views",
  description:
    "Developer-only Notes and Simple Calendar views for agent-driven view switching, interaction, persistence, and split-pane QA.",
  services: [SimpleViewsService],
  routes: simpleViewsRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      description:
        "A durable sticky-note workbench for testing agent-driven create, read, update, and delete flows.",
      icon: "StickyNote",
      path: "/notes",
      order: 920,
      developerOnly: true,
      viewKind: "developer",
      modalities: ["gui"],
      tags: [
        "notes",
        "notepad",
        "sticky notes",
        "scratchpad",
        "developer",
        "view switching",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "NotesView",
      surface: { header: "fullscreen" },
      capabilities: NOTES_CAPABILITIES,
      serverInteract,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "simple-calendar",
      label: "Simple Calendar",
      description:
        "A durable local calendar for testing agent-driven events, view switching, and split layouts without production calendar data.",
      icon: "CalendarDays",
      path: "/simple-calendar",
      order: 921,
      developerOnly: true,
      viewKind: "developer",
      modalities: ["gui"],
      tags: [
        "calendar",
        "calender",
        "test calendar",
        "events",
        "schedule",
        "developer",
        "view switching",
      ],
      bundlePath: "dist/views/bundle.js",
      componentExport: "SimpleCalendarView",
      surface: { header: "fullscreen" },
      capabilities: CALENDAR_CAPABILITIES,
      serverInteract,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    await runtime
      .getService<SimpleViewsService>(SimpleViewsService.serviceType)
      ?.stop();
  },
};

export default simpleViewsPlugin;
