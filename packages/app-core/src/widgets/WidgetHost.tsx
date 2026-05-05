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

import { Component, type ErrorInfo, type ReactNode, useMemo } from "react";
import type { ActivityEvent } from "../hooks/useActivityEvents";
import { useApp } from "../state";
import { useIsDeveloperMode } from "../state/useDeveloperMode";
import { resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";

// -- Error boundary ----------------------------------------------------------

interface WidgetErrorBoundaryProps {
  widgetId: string;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  error: Error | null;
}

class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  state: WidgetErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[widget:${this.props.widgetId}] render error:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
          data-testid={`widget-error-${this.props.widgetId}`}
        >
          Widget "{this.props.widgetId}" failed to render.
        </div>
      );
    }
    return this.props.children;
  }
}

// -- WidgetHost --------------------------------------------------------------

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

export function WidgetHost({
  slot,
  events,
  clearEvents,
  className,
  hideWhenEmpty = true,
  filter,
}: WidgetHostProps) {
  const { plugins } = useApp();
  const developerModeEnabled = useIsDeveloperMode();

  const resolved = useMemo(() => {
    const all = resolveWidgetsForSlot(slot, plugins ?? []);
    const gated = developerModeEnabled
      ? all
      : all.filter((entry) => entry.declaration.developerOnly !== true);
    return filter ? gated.filter((entry) => filter(entry.declaration)) : gated;
  }, [slot, plugins, filter, developerModeEnabled]);

  if (resolved.length === 0 && hideWhenEmpty) return null;

  return (
    <div
      className={`flex flex-col gap-3 ${className ?? ""}`}
      data-testid={`widget-host-${slot}`}
      data-slot={slot}
    >
      {resolved.map(({ declaration, Component }) => {
        const widgetKey = `${declaration.pluginId}/${declaration.id}`;
        const pluginState = (plugins ?? []).find(
          (p) => p.id === declaration.pluginId,
        );

        const widgetProps: WidgetProps = {
          pluginId: declaration.pluginId,
          pluginState,
          events,
          clearEvents,
        };

        if (Component) {
          return (
            <WidgetErrorBoundary key={widgetKey} widgetId={widgetKey}>
              <Component {...widgetProps} />
            </WidgetErrorBoundary>
          );
        }

        // Fallback: declarative uiSpec rendering (future — placeholder for now)
        if (declaration.uiSpec) {
          return (
            <WidgetErrorBoundary key={widgetKey} widgetId={widgetKey}>
              <div
                className="rounded-lg border border-border/60 bg-bg-accent/25 px-3 py-3 text-xs text-muted"
                data-testid={`widget-uispec-${declaration.id}`}
              >
                {declaration.label} (declarative widget)
              </div>
            </WidgetErrorBoundary>
          );
        }

        return null;
      })}
    </div>
  );
}
