import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "notes",
  pluginId: "@elizaos/plugin-simple-views",
  label: "Notes",
  icon: "StickyNote",
  path: "/notes",
  order: 920,
  viewKind: "developer",
  loader: () =>
    import("./ui.js").then((module) => ({
      default: module.NotesView,
    })),
});

registerAppShellPage({
  id: "simple-calendar",
  pluginId: "@elizaos/plugin-simple-views",
  label: "Simple Calendar",
  icon: "CalendarDays",
  path: "/simple-calendar",
  order: 921,
  viewKind: "developer",
  loader: () =>
    import("./ui.js").then((module) => ({
      default: module.SimpleCalendarView,
    })),
});
