/**
 * WidgetHost — renders all enabled plugin widgets for a named slot.
 *
 * Drop this into any page view:
 *   <WidgetHost slot="chat-sidebar" />
 *   <WidgetHost slot="home" layout="grid" />
 *
 * Queries the widget registry for matching declarations, wraps each in an
 * error boundary, and renders either the bundled React component or falls back
 * to the declarative UiRenderer for uiSpec widgets.
 */

import { isViewVisible } from "@elizaos/core";
import type * as React from "react";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useRef,
} from "react";
import { UiRenderer } from "../components/config-ui/ui-renderer";
import type { ActivityEvent } from "../hooks/useActivityEvents";
import { useNow } from "../hooks/useNow";
import { useAppSelectorShallow } from "../state";
import { useNotifications } from "../state/notifications/notification-store";
import { useEnabledViewKinds } from "../state/useViewKinds";
import { useHomeAttentionSignals } from "./home-attention-store";
import {
  type HomeWidgetSignal,
  homeSignalsFromEvents,
  homeSignalsFromNotifications,
  homeWidgetKey,
  rankHomeWidgets,
} from "./home-priority";
import { resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";
import { WIDGET_UI_ACTION_EVENT } from "./WidgetHost.constants";

export interface WidgetUiActionEventDetail {
  pluginId: string;
  widgetId: string;
  slot: WidgetSlot;
  action: string;
  params?: Record<string, unknown>;
}

function dispatchWidgetUiAction(
  declaration: PluginWidgetDeclaration,
  action: string,
  params?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  const detail: WidgetUiActionEventDetail = {
    pluginId: declaration.pluginId,
    widgetId: declaration.id,
    slot: declaration.slot,
    action,
    ...(params ? { params } : {}),
  };
  window.dispatchEvent(new CustomEvent(WIDGET_UI_ACTION_EVENT, { detail }));
}

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

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // error is captured in state via getDerivedStateFromError; ErrorBoundary shows fallback UI
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
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

/**
 * Safety bound on home cards. The home surface ranks every declared widget by
 * importance and renders them in order; each widget self-hides (renders `null`)
 * when it has nothing attention-worthy, so the *visible* count is naturally
 * small. This cap is just a guard against a pathological all-active state.
 */
const HOME_RENDER_CAP = 12;
const WIDGET_SLOTS: ReadonlySet<string> = new Set<WidgetSlot>([
  "chat-sidebar",
  "character",
  "nav-page",
  "home",
]);

function isWidgetSlot(value: string): value is WidgetSlot {
  return WIDGET_SLOTS.has(value);
}

export interface WidgetHostProps {
  /** Which slot to render widgets for. */
  slot: WidgetSlot;
  /** Activity events forwarded to widgets (primarily chat-sidebar). */
  events?: ActivityEvent[];
  /** Clear events callback. */
  clearEvents?: () => void;
  /** Additional CSS class on the host container. */
  className?: string;
  /**
   * Container layout. "stack" (default) is a vertical column (the chat rail);
   * "grid" is a responsive 1→2 column grid for surfaces that show several
   * widgets side by side (the frontpage home). (#9143)
   */
  layout?: "stack" | "grid";
  /** When true, render nothing if no widgets resolve (default: true). */
  hideWhenEmpty?: boolean;
  /**
   * Optional post-resolution filter. Useful for layering user-controlled
   * visibility overrides on top of the registry's plugin-enabled gate.
   */
  filter?: (declaration: PluginWidgetDeclaration) => boolean;
  /**
   * Rendered in place of an empty host (when `hideWhenEmpty` and no widget has
   * content). The home dashboard passes the always-on default widgets (clock /
   * date / calendar) here so it is never blank, while the data-driven widgets
   * keep self-hiding until they have something to show (#9143).
   */
  fallback?: ReactNode;
}

export function WidgetHost({
  slot,
  events,
  clearEvents,
  className,
  layout = "stack",
  hideWhenEmpty = true,
  filter,
  fallback,
}: WidgetHostProps) {
  const plugins = useAppSelectorShallow((s) => s.plugins);
  const enabledKinds = useEnabledViewKinds();
  // Live importance inputs for the home ranker. Subscribed unconditionally
  // (hooks can't be conditional) but only consumed for the `home` slot below.
  const { notifications } = useNotifications();
  const selfAttention = useHomeAttentionSignals();
  const now = useNow();

  const serverDeclarations = useMemo<PluginWidgetDeclaration[]>(() => {
    return (plugins ?? []).flatMap((plugin) =>
      (plugin.widgets ?? []).flatMap((widget) => {
        if (!isWidgetSlot(widget.slot)) return [];
        return [
          {
            ...widget,
            pluginId: widget.pluginId || plugin.id,
            slot: widget.slot,
          } satisfies PluginWidgetDeclaration,
        ];
      }),
    );
  }, [plugins]);

  const resolved = useMemo(() => {
    const all = resolveWidgetsForSlot(slot, plugins ?? [], serverDeclarations);
    const gated = all.filter((entry) =>
      isViewVisible(entry.declaration, enabledKinds),
    );
    return filter ? gated.filter((entry) => filter(entry.declaration)) : gated;
  }, [slot, plugins, serverDeclarations, filter, enabledKinds]);

  // Notification → signal inputs, memoized so the `now` tick (which re-runs the
  // component) doesn't rebuild this array each minute — it changes only when the
  // inbox itself changes.
  const notificationSignalInputs = useMemo(
    () =>
      notifications.map((n) => ({
        priority: n.priority,
        timestamp: n.createdAt,
        readAt: n.readAt,
      })),
    [notifications],
  );

  // The home surface ranks every declared widget by current importance and
  // renders them in that order; each widget self-hides (renders `null`) when it
  // has nothing attention-worthy, so the visible set is naturally focused
  // (#9143). Importance = a stable base priority (declaration `order`) plus:
  //  - decayed signals derived from the live activity stream + unread inbox,
  //    attributed to widgets whose `signalKinds` subscribe to that kind, and
  //  - sustained self-published attention (a widget floating itself up on its
  //    own data, e.g. an overdrawn balance), stamped `now` so it doesn't decay.
  // `now` comes from `useNow` (0 on first render, real clock in an effect) so
  // the render path never calls `Date.now()`. Other slots render every resolved
  // widget unchanged.
  const ranked = useMemo(() => {
    if (slot !== "home") return resolved;
    const renderable = resolved.filter((entry) => !entry.defaultWidgetSink);
    const declarations = renderable.map((entry) => entry.declaration);
    const signals: HomeWidgetSignal[] = [
      ...homeSignalsFromEvents(events ?? [], declarations),
      ...homeSignalsFromNotifications(notificationSignalInputs, declarations),
      ...selfAttention.map((entry) => ({ ...entry, timestamp: now })),
    ];
    const byKey = new Map(
      renderable.map((entry) => [homeWidgetKey(entry.declaration), entry]),
    );
    return rankHomeWidgets(declarations, signals, {
      now,
      maxVisible: HOME_RENDER_CAP,
    }).flatMap((ranked) => {
      const entry = byKey.get(homeWidgetKey(ranked.declaration));
      return entry ? [entry] : [];
    });
  }, [slot, resolved, events, notificationSignalInputs, selfAttention, now]);

  // `ranked` is recomputed on every `now` tick (decay math depends on `now`),
  // but the rendered *set and order* only change at discrete thresholds. Keep
  // the array reference stable across ticks that don't reorder: derive an
  // order-key from the resolved widget keys and only swap `displayed` when that
  // key changes. This stops the `.map` below — and therefore the widget
  // children — from rebuilding every minute when nothing moved (#9304). Order
  // still updates the instant a signal changes the ranking.
  const orderKey = ranked
    .map(({ declaration }) => homeWidgetKey(declaration))
    .join("|");
  const displayedRef = useRef<{
    key: string;
    resolved: typeof resolved;
    entries: typeof ranked;
  }>({ key: orderKey, resolved, entries: ranked });
  // Refresh the held set when the order changes OR when the resolved widgets
  // change identity (a plugin reload could keep the order but swap a
  // declaration/Component). A bare `now` tick changes neither, so the reference
  // — and the rendered children below — stay stable.
  if (
    displayedRef.current.key !== orderKey ||
    displayedRef.current.resolved !== resolved
  ) {
    displayedRef.current = { key: orderKey, resolved, entries: ranked };
  }
  const displayed = displayedRef.current.entries;

  const pluginById = useMemo(() => {
    const map = new Map<string, (typeof plugins)[number]>();
    for (const p of plugins ?? []) map.set(p.id, p);
    return map;
  }, [plugins]);

  // The fields every widget shares this render — split out so the per-item props
  // object is built from one stable base rather than re-derived inline.
  const widgetPropsBase = useMemo(
    () => ({ events, clearEvents, slot }),
    [events, clearEvents, slot],
  );

  // The rendered children, memoized on the stable order-key + the stable prop
  // inputs. A `now` tick that doesn't reorder leaves every dependency unchanged,
  // so this memo returns the SAME element array and the widget children never
  // re-render (locked by WidgetHost.render-storm.test.tsx). It rebuilds only
  // when the order, the resolved set, the plugin snapshot, or the shared props
  // actually change.
  const children = useMemo(
    () =>
      displayed
        .map(({ declaration, Component }) => {
          const widgetKey = `${declaration.pluginId}/${declaration.id}`;
          const widgetProps: WidgetProps = {
            ...widgetPropsBase,
            pluginId: declaration.pluginId,
            pluginState: pluginById.get(declaration.pluginId),
          };

          if (Component) {
            return (
              <WidgetErrorBoundary key={widgetKey} widgetId={widgetKey}>
                <Component {...widgetProps} />
              </WidgetErrorBoundary>
            );
          }

          if (declaration.uiSpec) {
            return (
              <WidgetErrorBoundary key={widgetKey} widgetId={widgetKey}>
                <div
                  className="min-w-0"
                  data-testid={`widget-uispec-${declaration.id}`}
                >
                  <UiRenderer
                    spec={declaration.uiSpec}
                    onAction={(action, params) =>
                      dispatchWidgetUiAction(declaration, action, params)
                    }
                  />
                </div>
              </WidgetErrorBoundary>
            );
          }

          return null;
        })
        .filter((node): node is React.JSX.Element => node !== null),
    [displayed, widgetPropsBase, pluginById],
  );

  // Nothing to show: render the caller's fallback (the home's default
  // clock/date/calendar widgets) so a dashboard is never blank, or hide.
  if (children.length === 0 && hideWhenEmpty) {
    return fallback ?? null;
  }

  const layoutClass =
    layout === "grid"
      ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
      : "flex flex-col gap-3";

  return (
    <div
      // `contain: layout` (CSS containment): a widget reorder/resize repaints
      // within this host and never reflows the surrounding page, so a ranking
      // change doesn't jump the whole home (#9304).
      className={`${layoutClass} ${className ?? ""}`}
      style={{ contain: "layout" }}
      data-testid={`widget-host-${slot}`}
      data-layout={layout}
      data-slot={slot}
    >
      {children}
    </div>
  );
}
