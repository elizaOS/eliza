/**
 * LifeOps widgets module — side-effect import registers:
 *   1. LifeOps client methods on ElizaClient (via ../api/client-lifeops)
 *   2. LifeOps widget components in the app-core widget registry
 *   3. LifeOps sidebar widget declarations for the "chat-sidebar" slot
 *
 * Usage:
 *   import "@elizaos/app-lifeops/widgets";
 */

// Side-effect: augment ElizaClient with LifeOps methods.
import "../api/client-lifeops.js";
import {
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
} from "@elizaos/app-core/widgets";
import {
  LIFEOPS_OVERVIEW_WIDGETS,
  LifeOpsOverviewSidebarWidget,
} from "../components/chat/widgets/plugins/lifeops-overview.js";
import { LIFEOPS_CALENDAR_WIDGET } from "../components/chat/widgets/plugins/lifeops-widget-calendar.js";
import { LIFEOPS_INBOX_WIDGET } from "../components/chat/widgets/plugins/lifeops-widget-inbox.js";
import { LIFEOPS_REMINDERS_WIDGET } from "../components/chat/widgets/plugins/lifeops-widget-reminders.js";
import { LIFEOPS_SCHEDULE_WIDGET } from "../components/chat/widgets/plugins/lifeops-widget-schedule.js";

registerBuiltinWidgets([
  ...LIFEOPS_OVERVIEW_WIDGETS,
  LIFEOPS_SCHEDULE_WIDGET,
  LIFEOPS_REMINDERS_WIDGET,
  LIFEOPS_CALENDAR_WIDGET,
  LIFEOPS_INBOX_WIDGET,
]);

registerBuiltinWidgetDeclarations(
  [
    {
      id: "lifeops.overview",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps",
      icon: "Sparkles",
      order: 90,
      defaultEnabled: true,
    },
    {
      id: "lifeops.schedule",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Schedule",
      icon: "Moon",
      order: 80,
      defaultEnabled: true,
    },
    {
      id: "lifeops.reminders",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Reminders",
      icon: "BellRing",
      order: 82,
      defaultEnabled: true,
    },
    {
      id: "lifeops.calendar",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Calendar",
      icon: "CalendarDays",
      order: 84,
      defaultEnabled: true,
    },
    {
      id: "lifeops.inbox",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Inbox",
      icon: "Inbox",
      order: 86,
      defaultEnabled: true,
    },
  ],
  { fallbackPluginIds: ["lifeops"] },
);

export { LIFEOPS_OVERVIEW_WIDGETS, LifeOpsOverviewSidebarWidget };
