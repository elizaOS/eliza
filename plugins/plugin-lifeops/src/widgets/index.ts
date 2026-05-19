import "../api/client-lifeops.js";
import {
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
} from "@elizaos/ui";
import { LIFEOPS_CHANNEL_WIDGETS } from "../components/chat/widgets/plugins/lifeops-channels.js";
import {
  LIFEOPS_OVERVIEW_WIDGETS,
  LifeOpsOverviewSidebarWidget,
} from "../components/chat/widgets/plugins/lifeops-overview.js";

// The consolidated "Glance" overview is intentionally not registered —
// the right rail now surfaces Calendar, Inbox, and Automations as three
// focused widgets instead. The overview component stays exported so the
// LifeOps page view (or future entry points) can still render it.
registerBuiltinWidgets([...LIFEOPS_CHANNEL_WIDGETS]);

registerBuiltinWidgetDeclarations(
  [
    {
      id: "lifeops.calendar",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "Calendar",
      icon: "CalendarDays",
      order: 85,
      defaultEnabled: true,
    },
    {
      id: "lifeops.inbox",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "Inbox",
      icon: "Mail",
      order: 86,
      defaultEnabled: true,
    },
    {
      id: "lifeops.automations",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "Automations",
      icon: "Clock",
      order: 87,
      defaultEnabled: true,
    },
  ],
  { fallbackPluginIds: ["lifeops"] },
);

export { LIFEOPS_OVERVIEW_WIDGETS, LifeOpsOverviewSidebarWidget };
