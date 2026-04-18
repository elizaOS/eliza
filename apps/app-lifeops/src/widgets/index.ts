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
  LifeOpsOverviewSidebarWidget,
  LIFEOPS_OVERVIEW_WIDGETS,
} from "../components/chat/widgets/plugins/lifeops-overview.js";

registerBuiltinWidgets(LIFEOPS_OVERVIEW_WIDGETS);

registerBuiltinWidgetDeclarations(
  [
    {
      id: "lifeops.overview",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Glance",
      icon: "Sparkles",
      order: 90,
      defaultEnabled: true,
    },
  ],
  { fallbackPluginIds: ["lifeops"] },
);

export { LifeOpsOverviewSidebarWidget, LIFEOPS_OVERVIEW_WIDGETS };
