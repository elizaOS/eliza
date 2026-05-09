import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";
import type { WidgetProps } from "./types";

var COMPONENT_REGISTRY: Map<string, React.ComponentType<WidgetProps>> | undefined;

function getComponentRegistry(): Map<string, React.ComponentType<WidgetProps>> {
  COMPONENT_REGISTRY ??= new Map<string, React.ComponentType<WidgetProps>>();
  return COMPONENT_REGISTRY;
}

/**
 * Register a bundled React component for a widget declaration.
 * Key format: `${pluginId}/${declarationId}`.
 */
export function registerWidgetComponent(
  pluginId: string,
  declarationId: string,
  Component: React.ComponentType<WidgetProps>,
): void {
  getComponentRegistry().set(`${pluginId}/${declarationId}`, Component);
}

/** Look up a registered component. */
export function getWidgetComponent(
  pluginId: string,
  declarationId: string,
): React.ComponentType<WidgetProps> | undefined {
  return getComponentRegistry().get(`${pluginId}/${declarationId}`);
}

/**
 * Adapts existing ChatSidebarWidgetDefinition[] to the new registry format.
 * These legacy widgets used `ChatSidebarWidgetProps` which is compatible with
 * `WidgetProps` (events + clearEvents).
 */
export function seedLegacyWidgets(
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

/**
 * Public API for plugins outside app-core to seed their own widget components.
 * Call this when your plugin loads (e.g. via side-effect import of a widgets
 * module). Each definition must be a `ChatSidebarWidgetDefinition`.
 */
export function registerBuiltinWidgets(
  definitions: ReadonlyArray<ChatSidebarWidgetDefinition>,
): void {
  seedLegacyWidgets(definitions);
}
