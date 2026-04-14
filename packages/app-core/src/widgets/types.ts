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
 * Comes from the server via GET /api/plugins.
 */
export interface PluginWidgetDeclaration {
  /** Unique within the owning plugin, e.g. "lifeops-overview". */
  id: string;
  /** Owning plugin ID — matches PluginInfo.id. */
  pluginId: string;
  /** Where this widget renders. */
  slot: WidgetSlot;
  /** Human-readable label. */
  label: string;
  /** Lucide icon name (e.g. "ListTodo"). */
  icon?: string;
  /** Sort priority within the slot (lower = first). Default 100. */
  order?: number;
  /** Show by default when plugin is active. Default true. */
  defaultEnabled?: boolean;
  /** For nav-page slot: which header TabGroup to join. */
  navGroup?: string;
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
