import type { ComponentType } from "react";
import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";
import type { WidgetProps } from "./types";

let COMPONENT_REGISTRY: Map<string, ComponentType<WidgetProps>> | undefined;

function getComponentRegistry(): Map<string, ComponentType<WidgetProps>> {
  COMPONENT_REGISTRY ??= new Map<string, ComponentType<WidgetProps>>();
  return COMPONENT_REGISTRY;
}

/**
 * Register a bundled React component for a widget declaration.
 * Key format: `${pluginId}/${declarationId}`.
 */
export function registerWidgetComponent(
  pluginId: string,
  declarationId: string,
  Component: ComponentType<WidgetProps>,
): void {
  getComponentRegistry().set(`${pluginId}/${declarationId}`, Component);
}

/** Look up a registered component. */
export function getWidgetComponent(
  pluginId: string,
  declarationId: string,
): ComponentType<WidgetProps> | undefined {
  return getComponentRegistry().get(`${pluginId}/${declarationId}`);
}

/**
 * Register bundled widget React components from `ChatSidebarWidgetDefinition[]`.
 * `ChatSidebarWidgetProps` is structurally compatible with `WidgetProps`
 * (events + clearEvents).
 *
 * This is the public API for plugins outside app-core to register their own
 * widget components — call it when the plugin loads (e.g. via a side-effect
 * import of a widgets module).
 */
export function registerBuiltinWidgets(
  definitions: ReadonlyArray<ChatSidebarWidgetDefinition>,
): void {
  for (const def of definitions) {
    registerWidgetComponent(
      def.pluginId,
      def.id,
      def.Component as ComponentType<WidgetProps>,
    );
  }
}
