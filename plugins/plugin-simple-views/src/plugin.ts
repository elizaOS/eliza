/**
 * Runtime declaration for managed Cloud Notes and Calendar. It contributes
 * two agent-drivable views backed by one durable per-agent service while
 * delegating navigation and interaction transport to the shared VIEWS system.
 */

import type { Plugin } from "@elizaos/core";
import { CALENDAR_CAPABILITIES, NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { simpleViewsRoutes } from "./routes.js";
import { SimpleViewsService } from "./service.js";

export const simpleViewsPlugin: Plugin = {
  name: "@elizaos/plugin-simple-views",
  description:
    "Managed Cloud Notes and Calendar views with durable agent-driven CRUD and view switching.",
  services: [SimpleViewsService],
  routes: simpleViewsRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      description:
        "Durable notes that the user and agent can create, read, update, and delete.",
      icon: "StickyNote",
      path: "/notes",
      order: 920,
      viewKind: "release",
      modalities: ["gui"],
      tags: [
        "notes",
        "notepad",
        "sticky notes",
        "scratchpad",
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
      label: "Calendar",
      description:
        "A durable Cloud calendar for agent-driven events and view switching.",
      icon: "CalendarDays",
      path: "/simple-calendar",
      order: 921,
      viewKind: "release",
      modalities: ["gui"],
      tags: [
        "calendar",
        "calender",
        "simple calendar",
        "events",
        "schedule",
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
