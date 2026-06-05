// The `ChatSidebarWidgetDefinition` registration value for the LifeOps overview
// widget. Kept out of lifeops-overview.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.

import type { ChatSidebarWidgetDefinition } from "@elizaos/ui";
import { LifeOpsOverviewSidebarWidget } from "./lifeops-overview.js";

export const LIFEOPS_OVERVIEW_WIDGETS: ChatSidebarWidgetDefinition[] = [
  {
    id: "lifeops.overview",
    pluginId: "lifeops",
    order: 90,
    defaultEnabled: true,
    Component: LifeOpsOverviewSidebarWidget,
  },
];
