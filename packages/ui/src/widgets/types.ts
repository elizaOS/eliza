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
  | "automations";

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
