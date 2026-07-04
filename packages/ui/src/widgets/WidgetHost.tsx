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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { UiRenderer } from "../components/config-ui/ui-renderer";
import type { ActivityEvent } from "../hooks/useActivityEvents";
import { useNow } from "../hooks/useNow";
import { useAppSelectorShallow } from "../state";
import { useNotifications } from "../state/notifications/notification-store";
import { useEnabledViewKinds } from "../state/useViewKinds";
import { useHomeAttentionSignals } from "./home-attention-store";
import { isHomeWidgetSunset, useHomeDismissals } from "./home-dismissal-store";
import {
  type HomeWidgetSignal,
  homeSignalsFromEvents,
  homeSignalsFromNotifications,
  homeWidgetKey,
  rankHomeWidgets,
} from "./home-priority";
import {
  getWidgetRegistryVersion,
  resolveWidgetsForSlot,
  subscribeWidgetRegistry,
} from "./registry";
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
          className="px-3 py-2 text-xs text-danger"
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
const FULL_APP_SHELL_WIDGET_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "agent-orchestrator",
  "calendar",
  "finances",
  "goals",
  "health",
  "inbox",
  "needs-attention",
  "relationships",
  "todo",
]);

function isWidgetSlot(value: string): value is WidgetSlot {
  return WIDGET_SLOTS.has(value);
}

/**
 * Map a home widget's declared `size` to STATIC Tailwind grid-span classes.
 * The classes are spelled out as literals (never interpolated) so Tailwind's
 * content scanner keeps them. Default footprint is 2x1.
 */
function spanClassForSize(size: PluginWidgetDeclaration["size"]): string {
  if (!size) return "col-span-2 row-span-1";
  const cols =
    size.cols === 1
      ? "col-span-1"
      : size.cols === 4
        ? "col-span-4"
        : "col-span-2";
  const rows = size.rows === 2 ? "row-span-2" : "row-span-1";
  return `${cols} ${rows}`;
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
  const plugins = useAppSelectorShallow((s) =>
    Array.isArray(s.plugins) ? s.plugins : [],
  );
  const currentBaseUrl = useAppSelectorShallow(() => client.getBaseUrl());
  const enabledKinds = useEnabledViewKinds();
  // Re-resolve when a widget registers after this host mounted. Plugin widget
  // registration runs on the renderer idle path (after first paint), so a
  // widget can appear in the registry later than the plugin snapshot; folding
  // the registry version into the resolution memo keeps the slot current
  // without an unrelated state change to trigger it.
  const registryVersion = useSyncExternalStore(
    subscribeWidgetRegistry,
    getWidgetRegistryVersion,
    getWidgetRegistryVersion,
  );
  // Live importance inputs for the home ranker. Subscribed unconditionally
  // (hooks can't be conditional) but only consumed for the `home` slot below.
  const { notifications } = useNotifications();
  const selfAttention = useHomeAttentionSignals();
  // Persisted show-once-then-retire lifecycle (#9959): a sunset-able home widget
  // (FTU welcome, nudges) is filtered out once the user has acted on / dismissed
  // it, or it has been shown its allotted sessions.
  const dismissals = useHomeDismissals();
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: registryVersion re-runs resolveWidgetsForSlot so an idle-registered widget is picked up
  const resolved = useMemo(() => {
    const all = resolveWidgetsForSlot(slot, plugins ?? [], serverDeclarations);
    const fullAppShellRoutesEnabled =
      supportsFullAppShellRoutes(currentBaseUrl);
    const gated = all.filter(
      (entry) =>
        isViewVisible(entry.declaration, enabledKinds) &&
        (fullAppShellRoutesEnabled ||
          (!FULL_APP_SHELL_WIDGET_PLUGIN_IDS.has(entry.declaration.pluginId) &&
            entry.defaultWidgetSink !== "activity")),
    );
    return filter ? gated.filter((entry) => filter(entry.declaration)) : gated;
    // `registryVersion` is a resolution input: bumping it re-runs `resolveWidgetsForSlot`
    // so an idle-registered widget is picked up.
  }, [
    slot,
    plugins,
    serverDeclarations,
    filter,
    enabledKinds,
    currentBaseUrl,
    registryVersion,
  ]);

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
    const renderable = resolved.filter(
      (entry) =>
        !entry.defaultWidgetSink &&
        !isHomeWidgetSunset(
          homeWidgetKey(entry.declaration),
          entry.declaration.sunset,
          dismissals,
        ),
    );
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
  }, [
    slot,
    resolved,
    events,
    notificationSignalInputs,
    selfAttention,
    dismissals,
    now,
  ]);

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
          // Span classes only apply on the home 4-col grid; other slots leave
          // `spanClassName` undefined so their widgets stay full-width.
          const spanClassName =
            slot === "home" ? spanClassForSize(declaration.size) : undefined;
          const widgetProps: WidgetProps = {
            ...widgetPropsBase,
            pluginId: declaration.pluginId,
            pluginState: pluginById.get(declaration.pluginId),
            spanClassName,
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
                  className={`min-w-0 ${spanClassName ?? ""}`}
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
    [displayed, widgetPropsBase, pluginById, slot],
  );

  // Whether the resolved widgets actually rendered any visible DOM. `children`
  // counts RESOLVED widget elements, but each data widget self-hides (renders
  // `null`) when it has nothing to show — so the home can resolve the
  // always-visible cards (notifications, needs-response, …) yet paint nothing.
  // We measure the real rendered child count after layout and, when a `fallback`
  // is supplied (the home's default clock/calendar), show it whenever the
  // widgets painted nothing. Only meaningful when a fallback exists.
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderedEmpty, setRenderedEmpty] = useState(false);
  useLayoutEffect(() => {
    if (fallback == null) return;
    const el = containerRef.current;
    setRenderedEmpty(el == null || el.childElementCount === 0);
  });

  // No widget even resolved → render the fallback directly (or hide).
  if (children.length === 0 && hideWhenEmpty) {
    return fallback ?? null;
  }

  // The home slot uses a fixed 4-column grid so each widget's static col-span
  // class places it; other grid surfaces keep the responsive 1→2 column grid,
  // and non-grid layouts stay a vertical stack.
  const layoutClass =
    slot === "home"
      ? "grid grid-cols-4 gap-2.5"
      : layout === "grid"
        ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
        : "flex flex-col gap-3";

  const showFallback = fallback != null && renderedEmpty;

  return (
    <>
      <div
        ref={containerRef}
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
      {/* The widgets resolved but all self-hid (no data) → show the default
          widgets so the dashboard is never blank. The empty container above has
          zero height, so visually only the fallback shows. */}
      {showFallback ? fallback : null}
    </>
  );
}
