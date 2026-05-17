import type { ComponentType } from "react";
import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";
import type { WidgetProps } from "./types";
/**
 * Register a bundled React component for a widget declaration.
 * Key format: `${pluginId}/${declarationId}`.
 */
export declare function registerWidgetComponent(
  pluginId: string,
  declarationId: string,
  Component: ComponentType<WidgetProps>,
): void;
/** Look up a registered component. */
export declare function getWidgetComponent(
  pluginId: string,
  declarationId: string,
): ComponentType<WidgetProps> | undefined;
/**
 * Adapts existing ChatSidebarWidgetDefinition[] to the new registry format.
 * These legacy widgets used `ChatSidebarWidgetProps` which is compatible with
 * `WidgetProps` (events + clearEvents).
 */
export declare function seedLegacyWidgets(
  definitions: ReadonlyArray<ChatSidebarWidgetDefinition>,
): void;
/**
 * Public API for plugins outside app-core to seed their own widget components.
 * Call this when your plugin loads (e.g. via side-effect import of a widgets
 * module). Each definition must be a `ChatSidebarWidgetDefinition`.
 */
export declare function registerBuiltinWidgets(
  definitions: ReadonlyArray<ChatSidebarWidgetDefinition>,
): void;
//# sourceMappingURL=registry-store.d.ts.map
