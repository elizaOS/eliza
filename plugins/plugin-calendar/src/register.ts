/**
 * Registers Calendar as a signed app-shell page for native clients.
 *
 * The runtime remains the sole owner of calendar data, actions, and routes;
 * only the React surface is bundled locally because mobile stores prohibit
 * downloading executable view JavaScript from the connected agent.
 */

import { registerAppShellPage } from "@elizaos/ui";

let registered = false;

export function registerCalendarApp(): void {
  if (registered) return;
  registerAppShellPage({
    id: "calendar",
    pluginId: "@elizaos/plugin-calendar",
    label: "Calendar",
    icon: "CalendarDays",
    path: "/calendar",
    order: 910,
    viewKind: "release",
    surface: {
      header: "fullscreen",
      capabilities: ["agent-surface"],
    },
    loader: () =>
      import("./components/calendar/CalendarPage.tsx").then((module) => ({
        default: module.CalendarPage,
      })),
  });
  registered = true;
}
