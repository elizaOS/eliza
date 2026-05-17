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

export {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";
/**
 * Public API for plugins outside app-core to append widget declarations to the
 * built-in fallback list. Declarations appear in the sidebar when the runtime
 * plugin snapshot isn't available or when the plugin is in the fallback set.
 */
export declare function registerBuiltinWidgetDeclarations(
  declarations: ReadonlyArray<PluginWidgetDeclaration>,
  options?: {
    fallbackPluginIds?: ReadonlyArray<string>;
  },
): void;
export declare const BUILTIN_WIDGET_DECLARATIONS: PluginWidgetDeclaration[];
/** Minimal plugin state needed for widget resolution. */
export type WidgetPluginState = Pick<PluginInfo, "id" | "enabled" | "isActive">;
interface ResolvedWidget {
  declaration: PluginWidgetDeclaration;
  Component: React.ComponentType<WidgetProps> | null;
}
/**
 * Resolve all enabled widgets for a slot.
 *
 * Merges built-in declarations with any server-provided declarations
 * (from PluginInfo.widgets), deduplicating by declaration ID.
 */
export declare function resolveWidgetsForSlot(
  slot: WidgetSlot,
  plugins: readonly WidgetPluginState[],
  serverDeclarations?: readonly PluginWidgetDeclaration[],
): ResolvedWidget[];

import type { ChatSidebarPluginState } from "../components/chat/widgets/types";
export declare function resolveChatSidebarWidgets(
  plugins: readonly ChatSidebarPluginState[],
): {
  id: string;
  pluginId: string;
  order: number;
  defaultEnabled: boolean;
  Component: import("react").ComponentType<WidgetProps>;
}[];
//# sourceMappingURL=registry.d.ts.map
