import "../api/client-lifeops.js";
import {
  registerBuiltinWidgetDeclarations,
  registerBuiltinWidgets,
} from "@elizaos/app-core/widgets";
import {
  LIFEOPS_OVERVIEW_WIDGETS,
  LifeOpsOverviewSidebarWidget,
} from "../components/chat/widgets/plugins/lifeops-overview.js";

registerBuiltinWidgets([...LIFEOPS_OVERVIEW_WIDGETS]);

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
  ],
  { fallbackPluginIds: ["lifeops"] },
);

export { LIFEOPS_OVERVIEW_WIDGETS, LifeOpsOverviewSidebarWidget };
