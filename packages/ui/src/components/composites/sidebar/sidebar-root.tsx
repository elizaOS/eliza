import { cva } from "class-variance-authority";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  buildSidebarAutoRailItems,
  buildSidebarAutoRailItemsFromDom,
  type SidebarAutoRailItem,
} from "./sidebar-auto-rail";
import { SidebarBody } from "./sidebar-body";
import type { SidebarProps, SidebarVariant } from "./sidebar-types";

const sidebarRootVariants = cva(
  "mt-4 flex flex-col overflow-hidden text-sm transition-[width,min-width,border-radius,box-shadow,transform] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default:
          "relative isolate min-h-0 h-[calc(100%_-_1rem)] w-full shrink-0 rounded-l-none rounded-tr-2xl rounded-br-2xl border-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_76%,transparent),color-mix(in_srgb,var(--bg-muted)_97%,transparent))] backdrop-blur-md",
        mobile:
          "h-full w-full min-w-0 border-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_96%,transparent),color-mix(in_srgb,var(--bg)_92%,transparent))] shadow-none ring-0",
        "game-modal":
          "h-full rounded-sm border border-white/10 bg-[linear-gradient(180deg,rgba(11,12,17,0.9),rgba(8,10,14,0.82))] shadow-2xl backdrop-blur-xl",
      },
      collapsed: {
        true: "!w-0 !min-w-0 xl:!w-0 xl:!min-w-0 !border-0 !shadow-none !bg-transparent z-40",
        false: "",
      },
      resizable: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        collapsed: false,
        resizable: false,
        className:
          "!w-[18.5rem] !min-w-[18.5rem] xl:!w-[20rem] xl:!min-w-[20rem] shadow-lg",
      },
      {
        variant: "default",
        collapsed: false,
        resizable: true,
        className: "shadow-lg",
      },
      {
        variant: "default",
        collapsed: true,
        className: "shadow-md",
      },
    ],
    defaultVariants: {
      variant: "default",
      collapsed: false,
      resizable: false,
    },
  },
);

const sidebarHeaderVariants = cva("", {
  variants: {
    variant: {
      default: "shrink-0  px-3.5 pb-4 pt-3.5",
      mobile: "shrink-0  px-3.5 pb-4 pt-3.5",
      "game-modal": "shrink-0  px-3.5 pb-3 pt-3.5",
    },
    collapsed: {
      true: "flex min-h-0 flex-1 flex-col pb-0",
      false: "",
    },
  },
  compoundVariants: [
    {
      variant: "default",
      collapsed: true,
      className: " px-3.5 pt-3.5",
    },
  ],
  defaultVariants: {
    variant: "default",
    collapsed: false,
  },
});

const sidebarFooterVariants = cva(
  "relative z-10 mt-auto flex shrink-0 justify-end  px-3.5 pb-3.5 pt-2",
);

const sidebarControlButtonClassName =
  "h-11 w-11 rounded-sm border border-border/32 bg-card text-muted-strong shadow-sm transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:text-txt hover:shadow-md active:scale-95";

const sidebarMobileHeaderBarClassName =
  "sticky top-0 z-10 flex items-center justify-between bg-card/88 px-3.5 py-2.5 backdrop-blur-md";

const sidebarContentLayerClassName =
  "flex min-h-0 flex-1 flex-col origin-left transform-gpu transition-[opacity,transform,filter] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform,filter] motion-reduce:transform-none motion-reduce:transition-none";

const sidebarContentOverlayLayerClassName =
  "pointer-events-none absolute inset-0 z-10 select-none";

const sidebarMetaClassName = "mt-1.5 text-xs text-muted";

const DEFAULT_APP_SIDEBAR_SYNC_ID = "primary-app-sidebar";
const SIDEBAR_SYNC_STORAGE_PREFIX = "elizaos:ui:sidebar:";
const sidebarSyncListeners = new Map<string, Set<() => void>>();

function getSidebarCollapsedStorageKey(syncId: string) {
  return `${SIDEBAR_SYNC_STORAGE_PREFIX}${syncId}:collapsed`;
}

function readSidebarCollapsedSnapshot(
  syncId: string,
  fallbackValue: boolean,
): boolean {
  if (typeof window === "undefined") return fallbackValue;
  try {
    const raw = window.localStorage.getItem(
      getSidebarCollapsedStorageKey(syncId),
    );
    return raw == null ? fallbackValue : raw === "true";
  } catch {
    return fallbackValue;
  }
}

function writeSidebarCollapsed(syncId: string, collapsed: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      getSidebarCollapsedStorageKey(syncId),
      String(collapsed),
    );
  } catch {
    /* ignore persistence failures */
  }
  const listeners = sidebarSyncListeners.get(syncId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function subscribeSidebarCollapsedStore(
  syncId: string,
  onStoreChange: () => void,
) {
  const listeners = sidebarSyncListeners.get(syncId) ?? new Set<() => void>();
  listeners.add(onStoreChange);
  sidebarSyncListeners.set(syncId, listeners);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== getSidebarCollapsedStorageKey(syncId)) return;
    onStoreChange();
  };

  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      sidebarSyncListeners.delete(syncId);
    }
    if (
      typeof window !== "undefined" &&
      typeof window.removeEventListener === "function"
    ) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function useSidebarCollapsedStore(
  syncId: string | undefined,
  fallbackValue: boolean,
) {
  return React.useSyncExternalStore(
    React.useCallback(
      (onStoreChange: () => void) => {
        if (!syncId) return () => {};
        return subscribeSidebarCollapsedStore(syncId, onStoreChange);
      },
      [syncId],
    ),
    React.useCallback(
      () =>
        syncId
          ? readSidebarCollapsedSnapshot(syncId, fallbackValue)
          : fallbackValue,
      [fallbackValue, syncId],
    ),
    React.useCallback(() => fallbackValue, [fallbackValue]),
  );
}

function useControllableState({
  controlled,
  defaultValue,
  onChange,
  syncId,
}: {
  controlled: boolean | undefined;
  defaultValue: boolean | undefined;
  onChange?: (value: boolean) => void;
  syncId?: string;
}) {
  const fallbackValue = defaultValue ?? false;
  const hasBrowserSync = Boolean(syncId && typeof window !== "undefined");
  const syncedValue = useSidebarCollapsedStore(
    hasBrowserSync ? syncId : undefined,
    fallbackValue,
  );
  const [uncontrolled, setUncontrolled] = React.useState(fallbackValue);
  const isControlled = controlled !== undefined;
  const value = isControlled
    ? controlled
    : hasBrowserSync
      ? (syncedValue ?? fallbackValue)
      : uncontrolled;

  React.useEffect(() => {
    if (!hasBrowserSync || !syncId) return undefined;

    if (isControlled) {
      if (readSidebarCollapsedSnapshot(syncId, fallbackValue) !== controlled) {
        writeSidebarCollapsed(syncId, controlled);
      }
    }
  }, [controlled, fallbackValue, hasBrowserSync, isControlled, syncId]);

  const setValue = React.useCallback(
    (next: boolean) => {
      if (!isControlled && !hasBrowserSync) {
        setUncontrolled(next);
      }
      if (hasBrowserSync && syncId) {
        writeSidebarCollapsed(syncId, next);
      }
      onChange?.(next);
    },
    [hasBrowserSync, isControlled, onChange, syncId],
  );

  return [value, setValue] as const;
}

function useDefaultSidebarDesktopRailEnabled(variant: SidebarVariant) {
  const [isDesktop, setIsDesktop] = React.useState(() => {
    if (variant !== "default") return false;
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return true;
    }
    return window.matchMedia("(min-width: 820px)").matches;
  });

  React.useEffect(() => {
    if (variant !== "default") {
      setIsDesktop(false);
      return;
    }
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      setIsDesktop(true);
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 820px)");
    const update = () => setIsDesktop(mediaQuery.matches);

    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, [variant]);

  return isDesktop;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(mediaQuery.matches);

    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return prefersReducedMotion;
}

function areSidebarAutoRailItemsEqual(
  left: SidebarAutoRailItem[],
  right: SidebarAutoRailItem[],
) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      item.key === other?.key &&
      item.label === other?.label &&
      item.active === other?.active &&
      item.disabled === other?.disabled &&
      item.contentKind === other?.contentKind &&
      item.indicatorTone === other?.indicatorTone
    );
  });
}

type SidebarContentKind = "expanded" | "collapsed";
type SidebarTransitionDirection = "collapsing" | "expanding";
type SidebarTransitionPhase = "prepare" | "animate";

function getSidebarContentLayerMotionClassName({
  direction,
  kind,
  overlay = false,
  phase,
}: {
  direction: SidebarTransitionDirection | null;
  kind: SidebarContentKind;
  overlay?: boolean;
  phase: SidebarTransitionPhase | null;
}) {
  const isEntering =
    !overlay &&
    ((direction === "collapsing" && kind === "collapsed") ||
      (direction === "expanding" && kind === "expanded"));
  const isExiting =
    overlay &&
    ((direction === "collapsing" && kind === "expanded") ||
      (direction === "expanding" && kind === "collapsed"));

  if (!direction || !phase) {
    return "opacity-100 translate-x-0 scale-100 blur-0";
  }

  if (isEntering) {
    if (kind === "collapsed") {
      return phase === "prepare"
        ? "opacity-0 translate-x-[0.28rem] scale-[0.984] blur-[2px]"
        : "opacity-100 translate-x-0 scale-100 blur-0 [transition-delay:125ms]";
    }

    return phase === "prepare"
      ? "opacity-0 translate-x-[0.45rem] scale-[0.992] blur-[2px]"
      : "opacity-100 translate-x-0 scale-100 blur-0 [transition-delay:110ms]";
  }

  if (isExiting) {
    if (kind === "expanded") {
      return phase === "prepare"
        ? "opacity-100 translate-x-0 scale-100 blur-0"
        : "opacity-0 -translate-x-[0.55rem] scale-[0.988] blur-[2px] duration-[150ms]";
    }

    return phase === "prepare"
      ? "opacity-100 translate-x-0 scale-100 blur-0"
      : "opacity-0 -translate-x-[0.28rem] scale-[0.982] blur-[2px] duration-[145ms]";
  }

  return "opacity-100 translate-x-0 scale-100 blur-0";
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(
  function Sidebar(
    {
      testId,
      variant = "default",
      collapsible = false,
      contentIdentity,
      syncId,
      collapsed,
      defaultCollapsed = false,
      onCollapsedChange,
      header,
      footer,
      collapsedContent,
      collapsedRailAction,
      collapsedRailItems,
      collapseButtonLeading,
      onMobileClose,
      mobileTitle,
      mobileMeta,
      mobileCloseLabel = "Close sidebar",
      showExpandedCollapseButton = true,
      collapseButtonTestId,
      expandButtonTestId,
      collapseButtonAriaLabel = "Collapse sidebar",
      expandButtonAriaLabel = "Expand sidebar",
      bodyClassName,
      headerClassName,
      footerClassName,
      collapsedContentClassName,
      collapseButtonClassName,
      resizable = false,
      width,
      onWidthChange,
      minWidth = 200,
      maxWidth = 560,
      onCollapseRequest,
      className,
      children,
      style,
      ...props
    }: SidebarProps,
    ref,
  ) {
    const effectiveSyncId =
      syncId ??
      (variant === "default" && collapsible
        ? DEFAULT_APP_SIDEBAR_SYNC_ID
        : undefined);
    const [isCollapsed, setIsCollapsed] = useControllableState({
      controlled: collapsed,
      defaultValue: defaultCollapsed,
      onChange: onCollapsedChange,
      syncId: effectiveSyncId,
    });
    const desktopRailEnabled = useDefaultSidebarDesktopRailEnabled(variant);
    const prefersReducedMotion = usePrefersReducedMotion();
    const supportsCollapsedRail =
      variant === "default" && collapsible && desktopRailEnabled;
    const showsCollapsedState = supportsCollapsedRail && isCollapsed;
    const [contentTransition, setContentTransition] = React.useState<null | {
      direction: SidebarTransitionDirection;
      phase: SidebarTransitionPhase;
    }>(null);
    const hasCustomCollapsedContent = collapsedContent != null;
    const hasStructuredCollapsedRail =
      collapsedRailAction != null || collapsedRailItems != null;
    const autoRailSourceRef = React.useRef<HTMLDivElement | null>(null);
    const autoRailItemsFromTree = React.useMemo(
      () =>
        hasCustomCollapsedContent || hasStructuredCollapsedRail
          ? []
          : buildSidebarAutoRailItems(children),
      [children, hasCustomCollapsedContent, hasStructuredCollapsedRail],
    );
    const needsDomAutoRailFallback = React.useMemo(
      () =>
        !hasCustomCollapsedContent &&
        !hasStructuredCollapsedRail &&
        autoRailItemsFromTree.length === 0,
      [
        autoRailItemsFromTree.length,
        hasCustomCollapsedContent,
        hasStructuredCollapsedRail,
      ],
    );
    const [, setAutoRailItems] = React.useState(autoRailItemsFromTree);
    const renderedContentIdentity = contentIdentity ?? variant;

    React.useEffect(() => {
      setAutoRailItems(autoRailItemsFromTree);
    }, [autoRailItemsFromTree]);

    React.useEffect(() => {
      if (!needsDomAutoRailFallback) return;
      const sourceElement = autoRailSourceRef.current;
      if (!sourceElement) return;

      const domRailItems = buildSidebarAutoRailItemsFromDom(sourceElement);
      if (domRailItems.length > 0) {
        setAutoRailItems((currentItems) =>
          areSidebarAutoRailItemsEqual(currentItems, domRailItems)
            ? currentItems
            : domRailItems,
        );
      }
    }, [needsDomAutoRailFallback]);

    type SidebarTimerHandle = ReturnType<typeof globalThis.setTimeout>;

    const transitionFrameRef = React.useRef<number | SidebarTimerHandle | null>(
      null,
    );
    const transitionTimeoutRef = React.useRef<SidebarTimerHandle | null>(null);

    const clearTransitionTimers = React.useCallback(() => {
      if (typeof window === "undefined") return;
      const clearTimer =
        typeof window.clearTimeout === "function"
          ? window.clearTimeout.bind(window)
          : globalThis.clearTimeout.bind(globalThis);
      if (transitionFrameRef.current !== null) {
        const frameHandle = transitionFrameRef.current;
        if (typeof window.cancelAnimationFrame === "function") {
          if (typeof frameHandle === "number") {
            window.cancelAnimationFrame(frameHandle);
          } else {
            clearTimer(frameHandle);
          }
        } else {
          clearTimer(frameHandle);
        }
        transitionFrameRef.current = null;
      }
      if (transitionTimeoutRef.current !== null) {
        clearTimer(transitionTimeoutRef.current);
        transitionTimeoutRef.current = null;
      }
    }, []);

    const startContentTransition = React.useCallback(
      (direction: SidebarTransitionDirection, nextCollapsed: boolean) => {
        if (typeof window === "undefined" || prefersReducedMotion) {
          setContentTransition(null);
          setIsCollapsed(nextCollapsed);
          return;
        }

        clearTransitionTimers();
        setContentTransition({ direction, phase: "prepare" });
        setIsCollapsed(nextCollapsed);
        const scheduleTimeout =
          typeof window.setTimeout === "function"
            ? window.setTimeout.bind(window)
            : globalThis.setTimeout.bind(globalThis);
        const scheduleFrame =
          typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame.bind(window)
            : (callback: FrameRequestCallback) =>
                scheduleTimeout(() => callback(Date.now()), 16);
        transitionFrameRef.current = scheduleFrame(() => {
          setContentTransition({ direction, phase: "animate" });
          transitionFrameRef.current = null;
        });
        transitionTimeoutRef.current = scheduleTimeout(() => {
          setContentTransition(null);
          transitionTimeoutRef.current = null;
        }, 320);
      },
      [clearTransitionTimers, prefersReducedMotion, setIsCollapsed],
    );

    React.useEffect(() => clearTransitionTimers, [clearTransitionTimers]);

    const handleCollapse = React.useCallback(() => {
      startContentTransition("collapsing", true);
    }, [startContentTransition]);

    const handleExpand = React.useCallback(() => {
      startContentTransition("expanding", false);
    }, [startContentTransition]);

    const transitionDirection = contentTransition?.direction ?? null;
    const transitionPhase = contentTransition?.phase ?? null;
    const isCollapsing = transitionDirection === "collapsing";
    const isExpanding = transitionDirection === "expanding";

    const expandedBaseMotionClassName = getSidebarContentLayerMotionClassName({
      direction: transitionDirection,
      kind: "expanded",
      phase: transitionPhase,
    });
    const collapsedBaseMotionClassName = getSidebarContentLayerMotionClassName({
      direction: transitionDirection,
      kind: "collapsed",
      phase: transitionPhase,
    });
    const expandedOverlayMotionClassName =
      getSidebarContentLayerMotionClassName({
        direction: transitionDirection,
        kind: "expanded",
        overlay: true,
        phase: transitionPhase,
      });
    const collapsedOverlayMotionClassName =
      getSidebarContentLayerMotionClassName({
        direction: transitionDirection,
        kind: "collapsed",
        overlay: true,
        phase: transitionPhase,
      });

    const renderCollapsedView = ({
      layerClassName,
      overlay = false,
      renderHiddenAutoRailSource = false,
    }: {
      layerClassName: string;
      overlay?: boolean;
      renderHiddenAutoRailSource?: boolean;
    }) => (
      <div
        aria-hidden={overlay || undefined}
        className={cn(
          sidebarContentLayerClassName,
          overlay ? sidebarContentOverlayLayerClassName : undefined,
          layerClassName,
        )}
      >
        {renderHiddenAutoRailSource ? (
          <SidebarBody ref={autoRailSourceRef} className="hidden" aria-hidden>
            {children}
          </SidebarBody>
        ) : null}
      </div>
    );

    const renderExpandedView = ({
      layerClassName,
      overlay = false,
      provideAutoRailSourceRef = false,
    }: {
      layerClassName: string;
      overlay?: boolean;
      provideAutoRailSourceRef?: boolean;
    }) => (
      <div
        aria-hidden={overlay || undefined}
        className={cn(
          sidebarContentLayerClassName,
          overlay ? sidebarContentOverlayLayerClassName : undefined,
          layerClassName,
        )}
      >
        {supportsCollapsedRail && showExpandedCollapseButton ? (
          <div
            className={cn(
              "relative z-10 flex shrink-0 items-center gap-2 px-3.5 pb-2 pt-3.5",
              collapseButtonLeading ? "justify-between" : "justify-end",
              headerClassName,
            )}
          >
            {collapseButtonLeading ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {collapseButtonLeading}
              </div>
            ) : null}
            <Button
              variant="surface"
              size="icon"
              data-testid={collapseButtonTestId}
              className={cn(
                sidebarControlButtonClassName,
                collapseButtonClassName,
              )}
              aria-label={collapseButtonAriaLabel}
              onClick={handleCollapse}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
        {header ? (
          <div
            className={cn(
              sidebarHeaderVariants({
                variant,
                collapsed: false,
              }),
              headerClassName,
            )}
          >
            {header}
          </div>
        ) : null}
        <SidebarBody
          ref={provideAutoRailSourceRef ? autoRailSourceRef : undefined}
          className={bodyClassName}
        >
          {children}
        </SidebarBody>
        {footer ? (
          <div className={cn(sidebarFooterVariants(), footerClassName)}>
            {footer}
          </div>
        ) : null}
      </div>
    );

    const resizeActive =
      resizable && variant === "default" && !showsCollapsedState;
    const collapseThreshold = Math.max(minWidth - 40, 80);
    const handleResizePointerDown = React.useCallback(
      (event: React.PointerEvent<HTMLElement>) => {
        if (!resizeActive || typeof width !== "number") return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const target = event.currentTarget;
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        const onMove = (ev: PointerEvent) => {
          const delta = ev.clientX - startX;
          const nextRaw = startWidth + delta;
          if (nextRaw < collapseThreshold && onCollapseRequest) {
            onCollapseRequest();
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            return;
          }
          const clamped = Math.min(Math.max(nextRaw, minWidth), maxWidth);
          onWidthChange?.(clamped);
        };
        const onUp = () => {
          try {
            target.releasePointerCapture(event.pointerId);
          } catch {
            /* ignore */
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
      [
        collapseThreshold,
        maxWidth,
        minWidth,
        onCollapseRequest,
        onWidthChange,
        resizeActive,
        width,
      ],
    );

    const resizeStyle: React.CSSProperties | undefined = resizeActive
      ? { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }
      : undefined;
    const mergedStyle = { ...style, ...resizeStyle };

    return (
      <aside
        ref={ref}
        className={cn(
          sidebarRootVariants({
            variant,
            collapsed: variant === "default" ? showsCollapsedState : false,
            resizable: resizeActive,
          }),
          className,
        )}
        data-testid={testId}
        data-collapsed={showsCollapsedState || undefined}
        data-variant={variant}
        style={mergedStyle}
        {...props}
      >
        {resizeActive ? (
          <hr
            aria-orientation="vertical"
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={typeof width === "number" ? width : minWidth}
            tabIndex={0}
            data-testid="sidebar-resize-handle"
            onPointerDown={handleResizePointerDown}
            className="absolute inset-y-0 right-0 z-20 m-0 h-full w-3 -mr-1.5 cursor-col-resize touch-none select-none border-0 bg-transparent transition-colors hover:bg-accent/20"
          />
        ) : null}
        {showsCollapsedState && variant === "default" ? (
          <button
            type="button"
            data-testid={expandButtonTestId}
            className={cn(
              "fixed bottom-2 left-2 z-40 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
              collapseButtonClassName,
            )}
            aria-label={expandButtonAriaLabel}
            onClick={handleExpand}
          >
            <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        <React.Fragment key={renderedContentIdentity}>
          {variant === "mobile" ? (
            <div className={sidebarMobileHeaderBarClassName}>
              <div className="space-y-1">
                {mobileTitle ? <div>{mobileTitle}</div> : null}
                {mobileMeta ? (
                  <div className={sidebarMetaClassName}>{mobileMeta}</div>
                ) : null}
              </div>
              {onMobileClose ? (
                <Button
                  variant="surface"
                  size="icon"
                  className="h-11 w-11 min-h-touch min-w-touch rounded-sm"
                  onClick={onMobileClose}
                  aria-label={mobileCloseLabel}
                  title={mobileCloseLabel}
                  data-testid="conversations-mobile-close"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {showsCollapsedState
              ? renderCollapsedView({
                  layerClassName: collapsedBaseMotionClassName,
                  renderHiddenAutoRailSource:
                    !hasCustomCollapsedContent && !hasStructuredCollapsedRail,
                })
              : renderExpandedView({
                  layerClassName: expandedBaseMotionClassName,
                  provideAutoRailSourceRef:
                    !hasCustomCollapsedContent && !hasStructuredCollapsedRail,
                })}
            {isCollapsing
              ? renderExpandedView({
                  layerClassName: expandedOverlayMotionClassName,
                  overlay: true,
                })
              : null}
            {isExpanding
              ? renderCollapsedView({
                  layerClassName: collapsedOverlayMotionClassName,
                  overlay: true,
                })
              : null}
          </div>
        </React.Fragment>
      </aside>
    );
  },
);
