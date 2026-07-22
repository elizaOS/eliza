/**
 * Statically registers managed Cloud Notes and Calendar with the app shell.
 *
 * Native clients prohibit remotely supplied JavaScript, so both renderers are
 * lazy chunks in the signed app bundle while the runtime plugin supplies only
 * metadata, capabilities, and durable state.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "notes",
  pluginId: "@elizaos/plugin-simple-views",
  label: "Notes",
  icon: "StickyNote",
  path: "/notes",
  order: 920,
  viewKind: "release",
  surface: { header: "fullscreen" },
  loader: () =>
    import("./views/NotesView.tsx").then((module) => ({
      default: module.NotesView,
    })),
});

registerAppShellPage({
  id: "simple-calendar",
  pluginId: "@elizaos/plugin-simple-views",
  label: "Calendar",
  icon: "CalendarDays",
  path: "/simple-calendar",
  order: 921,
  viewKind: "release",
  surface: { header: "fullscreen" },
  loader: () =>
    import("./views/SimpleCalendarView.tsx").then((module) => ({
      default: module.SimpleCalendarView,
    })),
});
