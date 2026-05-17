/**
 * WidgetHost — renders all enabled plugin widgets for a named slot.
 *
 * Drop this into any page view:
 *   <WidgetHost slot="chat-sidebar" />
 *   <WidgetHost slot="wallet" />
 *
 * Queries the widget registry for matching declarations, wraps each in an
 * error boundary, and renders either the bundled React component or falls back
 * to the declarative UiRenderer for uiSpec widgets.
 */
import type { ActivityEvent } from "../hooks/useActivityEvents";
import type { PluginWidgetDeclaration, WidgetSlot } from "./types";
export interface WidgetHostProps {
  /** Which slot to render widgets for. */
  slot: WidgetSlot;
  /** Activity events forwarded to widgets (primarily chat-sidebar). */
  events?: ActivityEvent[];
  /** Clear events callback. */
  clearEvents?: () => void;
  /** Additional CSS class on the host container. */
  className?: string;
  /** When true, render nothing if no widgets resolve (default: true). */
  hideWhenEmpty?: boolean;
  /**
   * Optional post-resolution filter. Useful for layering user-controlled
   * visibility overrides on top of the registry's plugin-enabled gate.
   */
  filter?: (declaration: PluginWidgetDeclaration) => boolean;
}
export declare function WidgetHost({
  slot,
  events,
  clearEvents,
  className,
  hideWhenEmpty,
  filter,
}: WidgetHostProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=WidgetHost.d.ts.map
