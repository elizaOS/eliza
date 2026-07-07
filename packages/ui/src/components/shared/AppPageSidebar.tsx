/**
 * Opinionated wrapper over the composite `Sidebar` for in-page left rails
 * (conversations, wallet, config, etc.), applying the app's chromeless page
 * skin: no right-edge hairline, transparent background, an inline collapse
 * button in the footer. Adds width + collapsed persistence keyed by
 * `contentIdentity`/`syncId` in localStorage, and supports both controlled and
 * uncontrolled collapsed/width. The desktop `default` variant resizes and
 * persists; `mobile`/`game-modal` variants inherit the base sidebar behavior.
 */

import { PanelLeftClose } from "lucide-react";
import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import { shellLocalStorage } from "../../surface-realm-channel";
import { Sidebar } from "../composites/sidebar/sidebar-root";
import type { SidebarProps } from "../composites/sidebar/sidebar-types";
import { Button } from "../ui/button";

const DEFAULT_PAGE_SIDEBAR_WIDTH = 240;
const DEFAULT_PAGE_SIDEBAR_MIN_WIDTH = 200;
const DEFAULT_PAGE_SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_SYNC_STORAGE_PREFIX = "elizaos:ui:sidebar:";
const PAGE_SIDEBAR_WIDTH_STORAGE_PREFIX = "eliza:page-sidebar:";

const PAGE_SIDEBAR_ROOT_CLASS =
  // No right-edge hairline (#10710) — the content gutter separates columns.
  "!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !shadow-none";

const PAGE_SIDEBAR_FOOTER_CLASS = "!justify-stretch !px-2 !pt-1.5 !pb-2";
const PAGE_SIDEBAR_COLLAPSE_BUTTON_CLASS =
  "!border-0 !bg-transparent !shadow-none hover:!bg-transparent hover:!text-txt";

function joinClassNames(
  ...values: Array<string | false | null | undefined>
): string | undefined {
  const className = values.filter(Boolean).join(" ").trim();
  return className.length > 0 ? className : undefined;
}

function clampSidebarWidth(
  value: number,
  minWidth: number,
  maxWidth: number,
): number {
  return Math.min(Math.max(value, minWidth), maxWidth);
}

function buildPageSidebarWidthStorageKey(identity: string): string {
  return `${PAGE_SIDEBAR_WIDTH_STORAGE_PREFIX}${identity}:width`;
}

function buildSidebarCollapsedStorageKey(syncId: string): string {
  return `${SIDEBAR_SYNC_STORAGE_PREFIX}${syncId}:collapsed`;
}

function readStoredSidebarWidth(
  storageKey: string | null,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (!storageKey || typeof window === "undefined") {
    return clampSidebarWidth(defaultWidth, minWidth, maxWidth);
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) {
      return clampSidebarWidth(parsed, minWidth, maxWidth);
    }
  } catch {
    /* ignore sandboxed storage */
  }
  return clampSidebarWidth(defaultWidth, minWidth, maxWidth);
}

function persistSidebarWidth(storageKey: string | null, width: number): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(storageKey, String(width));
  } catch {
    /* ignore sandboxed storage */
  }
}

function readStoredSidebarCollapsed(
  syncId: string | undefined,
  fallbackValue: boolean,
): boolean {
  if (!syncId || typeof window === "undefined") return fallbackValue;
  try {
    const raw = window.localStorage.getItem(
      buildSidebarCollapsedStorageKey(syncId),
    );
    return raw == null ? fallbackValue : raw === "true";
  } catch {
    return fallbackValue;
  }
}

export interface AppPageSidebarProps
  extends Omit<SidebarProps, "defaultCollapsed" | "footer" | "width"> {
  bottomAction?: React.ReactNode;
  defaultCollapsed?: boolean;
  defaultWidth?: number;
  footer?: React.ReactNode;
  width?: number;
  widthStorageKey?: string;
}

export const AppPageSidebar = React.forwardRef<
  React.ElementRef<typeof Sidebar>,
  AppPageSidebarProps
>(function AppPageSidebar(
  {
    bottomAction,
    className,
    collapseButtonAriaLabel = "Collapse sidebar",
    collapseButtonClassName,
    collapsible = false,
    collapsed: collapsedProp,
    contentIdentity,
    defaultCollapsed = false,
    defaultWidth = DEFAULT_PAGE_SIDEBAR_WIDTH,
    expandButtonAriaLabel = "Expand sidebar",
    footer,
    footerClassName,
    header,
    headerClassName,
    maxWidth = DEFAULT_PAGE_SIDEBAR_MAX_WIDTH,
    minWidth = DEFAULT_PAGE_SIDEBAR_MIN_WIDTH,
    onCollapseRequest,
    onCollapsedChange,
    onWidthChange,
    onWidthCommit,
    resizable,
    showExpandedCollapseButton = false,
    syncId,
    testId,
    variant = "default",
    width: widthProp,
    widthStorageKey,
    ...props
  },
  ref,
): React.JSX.Element {
  const desktopDefaultVariant = variant === "default";
  const effectiveResizable = resizable ?? desktopDefaultVariant;
  const resolvedSyncId =
    syncId ??
    (desktopDefaultVariant && collapsible
      ? `eliza:page-sidebar:${contentIdentity ?? testId ?? "default"}`
      : undefined);
  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(() =>
    readStoredSidebarCollapsed(resolvedSyncId, defaultCollapsed),
  );
  const controlledCollapsed = collapsedProp !== undefined;
  const collapsed = controlledCollapsed ? collapsedProp : internalCollapsed;

  const handleCollapsedChange = useCallback(
    (next: boolean) => {
      if (!controlledCollapsed) {
        setInternalCollapsed(next);
      }
      onCollapsedChange?.(next);
    },
    [controlledCollapsed, onCollapsedChange],
  );

  const resolvedWidthStorageKey = useMemo(() => {
    if (widthStorageKey) return widthStorageKey;
    if (!desktopDefaultVariant || !effectiveResizable || !contentIdentity) {
      return null;
    }
    return buildPageSidebarWidthStorageKey(contentIdentity);
  }, [
    contentIdentity,
    desktopDefaultVariant,
    effectiveResizable,
    widthStorageKey,
  ]);

  const [internalWidth, setInternalWidth] = useState<number>(() =>
    readStoredSidebarWidth(
      resolvedWidthStorageKey,
      defaultWidth,
      minWidth,
      maxWidth,
    ),
  );
  const controlledWidth = widthProp !== undefined;
  const width = controlledWidth ? widthProp : internalWidth;

  // Per-frame during a drag: state only. localStorage writes happen once per
  // drag in handleWidthCommit — a synchronous storage write per frame stalls
  // the resize on high-rate pointer devices.
  const handleWidthChange = useCallback(
    (next: number) => {
      const clamped = clampSidebarWidth(next, minWidth, maxWidth);
      if (!controlledWidth) {
        setInternalWidth(clamped);
      }
      onWidthChange?.(clamped);
    },
    [controlledWidth, maxWidth, minWidth, onWidthChange],
  );

  const handleWidthCommit = useCallback(
    (next: number) => {
      const clamped = clampSidebarWidth(next, minWidth, maxWidth);
      if (!controlledWidth) {
        persistSidebarWidth(resolvedWidthStorageKey, clamped);
      }
      onWidthCommit?.(clamped);
    },
    [
      controlledWidth,
      maxWidth,
      minWidth,
      onWidthCommit,
      resolvedWidthStorageKey,
    ],
  );

  const defaultFooter =
    footer ??
    (desktopDefaultVariant && (collapsible || bottomAction) ? (
      <div
        className={joinClassNames(
          "flex w-full items-center gap-2",
          collapsible ? "justify-between" : "justify-end",
        )}
      >
        {collapsible ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => handleCollapsedChange(true)}
            aria-label={collapseButtonAriaLabel}
            data-testid={
              testId
                ? `${testId}-collapse-inline`
                : "page-sidebar-collapse-inline"
            }
            className="h-6 w-6 shrink-0 rounded-sm bg-transparent p-0 text-muted transition-colors hover:text-txt"
          >
            <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
        {bottomAction}
      </div>
    ) : undefined);

  return (
    <Sidebar
      {...props}
      ref={ref}
      testId={testId}
      variant={variant}
      collapsible={collapsible}
      collapsed={collapsed}
      onCollapsedChange={handleCollapsedChange}
      contentIdentity={contentIdentity}
      syncId={resolvedSyncId}
      header={header}
      footer={defaultFooter}
      showExpandedCollapseButton={showExpandedCollapseButton}
      collapseButtonAriaLabel={collapseButtonAriaLabel}
      expandButtonAriaLabel={expandButtonAriaLabel}
      className={joinClassNames(
        desktopDefaultVariant ? PAGE_SIDEBAR_ROOT_CLASS : undefined,
        className,
      )}
      headerClassName={joinClassNames(
        desktopDefaultVariant && header == null
          ? "!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
          : undefined,
        headerClassName,
      )}
      footerClassName={joinClassNames(
        defaultFooter && desktopDefaultVariant
          ? PAGE_SIDEBAR_FOOTER_CLASS
          : undefined,
        footerClassName,
      )}
      collapseButtonClassName={joinClassNames(
        desktopDefaultVariant ? PAGE_SIDEBAR_COLLAPSE_BUTTON_CLASS : undefined,
        collapseButtonClassName,
      )}
      resizable={effectiveResizable}
      width={effectiveResizable ? width : widthProp}
      onWidthChange={effectiveResizable ? handleWidthChange : onWidthChange}
      onWidthCommit={effectiveResizable ? handleWidthCommit : onWidthCommit}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onCollapseRequest={
        onCollapseRequest ?? (() => handleCollapsedChange(true))
      }
    />
  );
});
