/**
 * Declares the coding-orchestrator widgets exposed to host UI registries.
 *
 * This manifest is the authoritative roster; host-owned bundled components and
 * fallback declarations must retain parity with it.
 */

import type { PluginWidgetDeclaration } from "@elizaos/core";

export const AGENT_ORCHESTRATOR_WIDGET_DECLARATIONS = [
  {
    id: "agent-orchestrator.apps",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "App Runs",
    icon: "Activity",
    order: 150,
    defaultEnabled: true,
  },
  {
    id: "agent-orchestrator.accounts",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Coding accounts",
    icon: "Zap",
    order: 250,
    defaultEnabled: true,
  },
  {
    id: "agent-orchestrator.activity",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Activity",
    icon: "Activity",
    order: 300,
    defaultEnabled: true,
  },
] as const satisfies readonly PluginWidgetDeclaration[];
