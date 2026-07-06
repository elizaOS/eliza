/**
 * Types for the widget registry: slots, plugin widget declarations, and the
 * WidgetProps the host passes to each widget component.
 */
import type { PluginWidgetDeclaration as CorePluginWidgetDeclaration } from "@elizaos/core";
import type { ComponentType } from "react";
import type { PluginInfo } from "../api/client-types-config";
import type { UiSpec } from "../config/ui-spec";
import type { ActivityEvent } from "../hooks/useActivityEvents";

/** Named injection points where plugin widgets can render. */
export const WIDGET_SLOTS = [
  "chat-sidebar",
  "character",
  "nav-page",
  "home",
] as const;

export type WidgetSlot = (typeof WIDGET_SLOTS)[number];

/**
 * Show-once-then-retire lifecycle for a transient home-slot widget (for example, connector nudges). A widget with `sunset` is filtered out of the
 * home grid once its condition is met; the per-key lifecycle state is persisted
 * by `widgets/home-dismissal-store.ts`. Absent ⇒ the widget never sunsets (the
 * data-driven cards rely on self-hiding-when-empty, not on this).
 */
export interface HomeWidgetSunset {
  /** Retire after the widget has been shown in this many sessions (1 = show
   *  once, then gone next session). */
  afterSeen?: number;
  /** Retire once the user acts on it (e.g. taps a prompt chip). */
  afterAction?: boolean;
  /** Render a dismiss control; retire permanently once dismissed. */
  dismissible?: boolean;
}

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
  /** Show-once-then-retire lifecycle (home slot only). See {@link HomeWidgetSunset}. */
  sunset?: HomeWidgetSunset;
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
  /**
   * Static Tailwind grid-span classes for the home 4-col grid, derived from the
   * declaration's `size` by the host (e.g. "col-span-2 row-span-1"). The widget
   * applies this to its single root grid-item element. Absent off the home slot.
   */
  spanClassName?: string;
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
