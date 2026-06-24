import type { PluginWidgetDeclaration as CorePluginWidgetDeclaration } from "@elizaos/core";
import type { ComponentType } from "react";
import type { PluginInfo } from "../api/client-types-config";
import type { UiSpec } from "../config/ui-spec";
import type { ActivityEvent } from "../hooks/useActivityEvents";

/** Named injection points where plugin widgets can render. */
export type WidgetSlot =
  | "chat-sidebar"
  | "chat-inline"
  | "wallet"
  | "browser"
  | "heartbeats"
  | "character"
  | "settings"
  | "nav-page"
  | "automations"
  // Frontpage / Springboard home surface (#9143). Plugins opt a widget into the
  // home screen by declaring this slot; the Home/Springboard surface mounts it.
  | "home";

/**
 * Serializable widget metadata declared by a plugin.
 *
 * The canonical shape lives in `@elizaos/core` (`PluginWidgetDeclaration`)
 * so plugins can self-declare without depending on app-core. The client
 * surface adds an optional `uiSpec` for plugins without bundled React
 * components.
 */
export interface PluginWidgetDeclaration extends CorePluginWidgetDeclaration {
  /** Declarative UI spec — fallback for plugins without bundled React components. */
  uiSpec?: UiSpec;
}

/** Props passed to every widget React component. */
export interface WidgetProps {
  pluginId: string;
  pluginState?: PluginInfo;
  events?: ActivityEvent[];
  clearEvents?: () => void;
  /**
   * The slot this instance is rendering in. Lets a widget shared between the
   * chat sidebar and the home grid adapt — e.g. render `null` instead of an
   * empty-state card on `home` (the home surface must not show empty
   * placeholders; #9143).
   */
  slot?: WidgetSlot;
}

/**
 * Client-side registration mapping a widget declaration to a React component.
 * Bundled plugins register these statically; third-party plugins rely on uiSpec.
 */
export interface WidgetRegistration {
  /** Must match `PluginWidgetDeclaration.id`. */
  declarationId: string;
  /** Must match `PluginWidgetDeclaration.pluginId`. */
  pluginId: string;
  /** The React component to render. */
  Component: ComponentType<WidgetProps>;
}
