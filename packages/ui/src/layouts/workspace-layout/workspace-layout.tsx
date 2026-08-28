/**
 * WorkspaceLayout: the base two-pane shell (sidebar + content) with inside/
 * outside header placement and a mobile drawer.
 */
import * as React from "react";
import { Card } from "../../components/ui/card";
import { cn } from "../../lib/utils";
import { PageLayoutHeader } from "../page-layout/page-layout-header";
import { PageLayoutMobileDrawer } from "../page-layout/page-layout-mobile-drawer";
import type { WorkspaceLayoutProps } from "./workspace-layout-types";

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

function useWorkspaceLayoutDesktopMode() {
  const [isDesktop, setIsDesktop] = React.useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return true;
    }
    return window.matchMedia("(min-width: 820px) and (min-height: 600px)")
      .matches;
  });

  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      setIsDesktop(true);
      return;
    }

    const mediaQuery = window.matchMedia(
      "(min-width: 820px) and (min-height: 600px)",
    );
    const update = () => setIsDesktop(mediaQuery.matches);

    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return isDesktop;
}

export function WorkspaceLayout({
  children,
  className,
  contentClassName,
  contentHeader,
  contentHeaderClassName,
  contentInnerClassName,
  contentPadding = true,
  contentRef,
  footer,
  footerClassName,
  headerPlacement = "outside",
  mobileSidebarLabel,
  mobileSidebarTriggerClassName,
  sidebar,
  sidebarCollapsible = true,
  ...props
}: WorkspaceLayoutProps) {
  const isDesktop = useWorkspaceLayoutDesktopMode();
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);
  const mobileSidebarOpenerRef = React.useRef<HTMLElement | null>(null);
  const wasMobileSidebarOpenRef = React.useRef(false);
  const handleMobileSidebarOpenChange = React.useCallback((next: boolean) => {
    if (
      next &&
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
    ) {
      mobileSidebarOpenerRef.current = document.activeElement;
    }
    setMobileSidebarOpen(next);
  }, []);
  const setContentRef = React.useCallback(
    (node: HTMLElement | null) => assignRef(contentRef, node),
    [contentRef],
  );
  const showMobileSidebarPane = Boolean(
    sidebar && !isDesktop && mobileSidebarOpen,
  );

  React.useEffect(() => {
    if (isDesktop) {
      setMobileSidebarOpen(false);
    }
  }, [isDesktop]);

  React.useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const wasOpen = wasMobileSidebarOpenRef.current;
    wasMobileSidebarOpenRef.current = mobileSidebarOpen;
    if (mobileSidebarOpen) {
      document
        .querySelector<HTMLElement>(
          '[data-testid="page-layout-mobile-sidebar-drawer"] [data-testid="conversations-mobile-close"]',
        )
        ?.focus();
      return;
    }
    if (!wasOpen) return;
    const opener = mobileSidebarOpenerRef.current;
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    const focusRestoredTrigger = () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="page-layout-mobile-sidebar-trigger"]',
        )
        ?.focus();
    };
    const frame = window.requestAnimationFrame(focusRestoredTrigger);
    return () => window.cancelAnimationFrame(frame);
  }, [mobileSidebarOpen]);

  const desktopSidebarElement = sidebar
    ? React.cloneElement(sidebar, {
        className: cn("!mt-0 !h-full", sidebar.props.className),
        collapsible:
          sidebar.props.collapsible ?? (sidebarCollapsible && isDesktop),
        variant: sidebar.props.variant ?? "default",
      })
    : null;
  const headerElement = contentHeader ? (
    <PageLayoutHeader className={contentHeaderClassName}>
      {contentHeader}
    </PageLayoutHeader>
  ) : null;

  return (
    <div
      className={cn(
        "flex w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        className,
      )}
      {...props}
    >
      {contentHeader && headerPlacement === "outside" ? (
        <div className={cn("shrink-0", contentPadding && "px-2 pt-1")}>
          {headerElement}
        </div>
      ) : null}

      <div
        className={cn(
          "flex w-full min-h-0 min-w-0 flex-1 flex-col",
          sidebar && isDesktop && "flex-row",
        )}
      >
        {desktopSidebarElement ? (
          <div
            className={cn(
              "min-h-0 w-full shrink-0 items-stretch px-0 pb-0",
              isDesktop ? "flex w-auto" : "hidden",
              contentPadding && "pt-1",
            )}
          >
            {desktopSidebarElement}
          </div>
        ) : null}

        <Card asChild variant="transparentSquare">
          <main
            ref={setContentRef}
            className={cn(
              "chat-native-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col",
              showMobileSidebarPane ? "overflow-hidden" : "overflow-y-auto",
              contentPadding && !showMobileSidebarPane && "px-2 pb-4 pt-1",
              !showMobileSidebarPane && contentClassName,
            )}
          >
            {sidebar ? (
              <PageLayoutMobileDrawer
                isDesktop={isDesktop}
                mobileSidebarLabel={mobileSidebarLabel}
                mobileSidebarOpen={mobileSidebarOpen}
                mobileSidebarTriggerClassName={mobileSidebarTriggerClassName}
                onMobileSidebarOpenChange={handleMobileSidebarOpenChange}
                sidebar={sidebar}
              />
            ) : null}

            {contentHeader &&
            headerPlacement === "inside" &&
            !showMobileSidebarPane
              ? headerElement
              : null}

            <div
              className={cn(
                "flex w-full min-h-0 flex-1 flex-col",
                contentInnerClassName,
                showMobileSidebarPane && "hidden",
              )}
            >
              {children}
            </div>
          </main>
        </Card>
      </div>
    </div>
  );
}
