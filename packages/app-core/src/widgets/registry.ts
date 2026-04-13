/**
 * Plugin widget registry.
 *
 * Maintains a static map of plugin widget React components (bundled plugins)
 * and resolves widgets for a given slot based on plugin state.
 *
 * Third-party plugins without bundled React components can provide a `uiSpec`
 * in their widget declaration, which gets rendered by `UiRenderer` via the
 * `WidgetHost` component.
 */

import type { PluginInfo } from "../api/client-types-config";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";

// -- Bundled widget component imports ----------------------------------------

import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/plugins/agent-orchestrator";
import { LIFEOPS_WIDGETS } from "../components/chat/widgets/plugins/lifeops";
import { LIFEOPS_OVERVIEW_WIDGETS } from "../components/chat/widgets/plugins/lifeops-overview";
import { TODO_PLUGIN_WIDGETS } from "../components/chat/widgets/plugins/todo";
import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";

// -- Static component registry -----------------------------------------------

const COMPONENT_REGISTRY = new Map<string, React.ComponentType<WidgetProps>>();

/**
 * Register a bundled React component for a widget declaration.
 * Key format: `${pluginId}/${declarationId}`.
 */
export function registerWidgetComponent(
  pluginId: string,
  declarationId: string,
  Component: React.ComponentType<WidgetProps>,
): void {
  COMPONENT_REGISTRY.set(`${pluginId}/${declarationId}`, Component);
}

/** Look up a registered component. */
export function getWidgetComponent(
  pluginId: string,
  declarationId: string,
): React.ComponentType<WidgetProps> | undefined {
  return COMPONENT_REGISTRY.get(`${pluginId}/${declarationId}`);
}

// -- Seed bundled widgets into the registry ----------------------------------

/**
 * Adapts existing ChatSidebarWidgetDefinition[] to the new registry format.
 * These legacy widgets used `ChatSidebarWidgetProps` which is compatible with
 * `WidgetProps` (events + clearEvents).
 */
function seedLegacyWidgets(
  definitions: ReadonlyArray<ChatSidebarWidgetDefinition>,
): void {
  for (const def of definitions) {
    registerWidgetComponent(
      def.pluginId,
      def.id,
      def.Component as React.ComponentType<WidgetProps>,
    );
  }
}

seedLegacyWidgets(LIFEOPS_OVERVIEW_WIDGETS);
seedLegacyWidgets(LIFEOPS_WIDGETS);
seedLegacyWidgets(AGENT_ORCHESTRATOR_PLUGIN_WIDGETS);
seedLegacyWidgets(TODO_PLUGIN_WIDGETS);

// -- Built-in widget declarations --------------------------------------------
// These are the widget declarations for bundled plugins. They mirror what
// the server will eventually provide via GET /api/plugins, but are also
// available client-side for zero-config rendering.

export const BUILTIN_WIDGET_DECLARATIONS: PluginWidgetDeclaration[] = [
  // LifeOps overview
  {
    id: "lifeops.overview",
    pluginId: "lifeops",
    slot: "chat-sidebar",
    label: "LifeOps Overview",
    icon: "Sparkles",
    order: 90,
    defaultEnabled: true,
  },
  // LifeOps Google (calendar + gmail)
  {
    id: "lifeops.google",
    pluginId: "lifeops",
    slot: "chat-sidebar",
    label: "Google Services",
    icon: "Plug2",
    order: 150,
    defaultEnabled: true,
  },
  // Todo
  {
    id: "todo.items",
    pluginId: "todo",
    slot: "chat-sidebar",
    label: "Tasks",
    icon: "ListTodo",
    order: 100,
    defaultEnabled: true,
  },
  // Agent Orchestrator — app runs
  {
    id: "agent-orchestrator.apps",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "App Runs",
    icon: "Activity",
    order: 150,
    defaultEnabled: true,
  },
  // Agent Orchestrator — tasks
  {
    id: "agent-orchestrator.tasks",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Tasks",
    icon: "ListTodo",
    order: 200,
    defaultEnabled: true,
  },
  // Agent Orchestrator — activity
  {
    id: "agent-orchestrator.activity",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Activity",
    icon: "Activity",
    order: 300,
    defaultEnabled: true,
  },
];

// -- Resolution --------------------------------------------------------------

/** Minimal plugin state needed for widget resolution. */
export type WidgetPluginState = Pick<PluginInfo, "id" | "enabled" | "isActive">;

interface ResolvedWidget {
  declaration: PluginWidgetDeclaration;
  Component: React.ComponentType<WidgetProps> | null;
}

function isWidgetEnabled(
  declaration: PluginWidgetDeclaration,
  plugins: readonly WidgetPluginState[],
): boolean {
  if (plugins.length === 0) {
    return declaration.defaultEnabled !== false;
  }

  const plugin = plugins.find((p) => p.id === declaration.pluginId);
  if (!plugin) return false;

  return plugin.isActive === true || plugin.enabled !== false;
}

/**
 * Resolve all enabled widgets for a slot.
 *
 * Merges built-in declarations with any server-provided declarations
 * (from PluginInfo.widgets), deduplicating by declaration ID.
 */
export function resolveWidgetsForSlot(
  slot: WidgetSlot,
  plugins: readonly WidgetPluginState[],
  serverDeclarations?: readonly PluginWidgetDeclaration[],
): ResolvedWidget[] {
  // Merge: server declarations override built-in by id
  const declarationMap = new Map<string, PluginWidgetDeclaration>();

  for (const decl of BUILTIN_WIDGET_DECLARATIONS) {
    if (decl.slot === slot) {
      declarationMap.set(`${decl.pluginId}/${decl.id}`, decl);
    }
  }

  if (serverDeclarations) {
    for (const decl of serverDeclarations) {
      if (decl.slot === slot) {
        declarationMap.set(`${decl.pluginId}/${decl.id}`, decl);
      }
    }
  }

  const results: ResolvedWidget[] = [];

  for (const declaration of declarationMap.values()) {
    if (!isWidgetEnabled(declaration, plugins)) continue;

    const Component = getWidgetComponent(declaration.pluginId, declaration.id);

    // Include if we have a React component OR a uiSpec fallback
    if (Component || declaration.uiSpec) {
      results.push({ declaration, Component: Component ?? null });
    }
  }

  results.sort(
    (a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100),
  );

  return results;
}

// -- Backward compatibility --------------------------------------------------
// Re-export a function matching the old `resolveChatSidebarWidgets` signature
// so existing consumers (TasksEventsPanel) work during migration.

import type { ChatSidebarPluginState } from "../components/chat/widgets/types";

export function resolveChatSidebarWidgets(
  plugins: readonly ChatSidebarPluginState[],
) {
  return resolveWidgetsForSlot("chat-sidebar", plugins).map((w) => ({
    id: w.declaration.id,
    pluginId: w.declaration.pluginId,
    order: w.declaration.order ?? 100,
    defaultEnabled: w.declaration.defaultEnabled !== false,
    // biome-ignore lint/style/noNonNullAssertion: chat-sidebar widgets always have bundled components
    Component: w.Component!,
  }));
}
