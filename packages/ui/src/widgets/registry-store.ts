/**
 * Runtime registry mapping widget ids to their React components, so plugins and
 * the host contribute chat-sidebar widgets the WidgetHost renders.
 */
import type { ComponentType } from "react";
import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";
import type { WidgetProps } from "./types";

let COMPONENT_REGISTRY: Map<string, ComponentType<WidgetProps>> | undefined;

function getComponentRegistry(): Map<string, ComponentType<WidgetProps>> {
  COMPONENT_REGISTRY ??= new Map<string, ComponentType<WidgetProps>>();
  return COMPONENT_REGISTRY;
}

// -- Registry change notification --------------------------------------------
// The widget registry is a plain Map that plugins mutate as they load. Plugin
// registration modules load on the renderer idle path (after first paint; see
// `SIDE_EFFECT_APP_MODULE_LOADERS` in the app shell), so a widget can register
// *after* a home/sidebar host has already resolved its slot. Because slot
// resolution is a pure function of (registry state + plugin snapshot), the host
// must re-resolve when the registry changes — otherwise an idle-registered
// widget (e.g. plugin-wallet-ui's chat-sidebar widget) is silently dropped
// until an unrelated plugin-snapshot change happens to re-run resolution.
//
// This is a `useSyncExternalStore` source: a monotonic version counter plus a
// listener set. Registration bumps the version and notifies; hosts subscribe
// and fold the version into their resolution memo.
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function notifyRegistryChanged(): void {
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

/**
 * Subscribe to widget-registry mutations (component/declaration registration).
 * Returns an unsubscribe function. `useSyncExternalStore`-compatible.
 */
export function subscribeWidgetRegistry(onChange: () => void): () => void {
  registryListeners.add(onChange);
  return () => {
    registryListeners.delete(onChange);
  };
}

/**
 * Current registry version — increments on every registration. Stable between
 * registrations, so `useSyncExternalStore` re-renders a host only when the set
 * of registered widgets actually changed.
 */
export function getWidgetRegistryVersion(): number {
  return registryVersion;
}

/**
 * Signal that a widget declaration (not a component) was registered. Declaration
 * registration lives in `registry.ts`, which calls this so declaration-only
 * plugins trigger the same re-resolution as component registration.
 */
export function markWidgetRegistryChanged(): void {
  notifyRegistryChanged();
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
  notifyRegistryChanged();
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
