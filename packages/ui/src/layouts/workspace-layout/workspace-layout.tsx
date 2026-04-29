import * as React from "react";

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
    return window.matchMedia("(min-width: 820px)").matches;
  });

  React.useEffect(() => {
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
  const showMobileSidebarPane = Boolean(
    sidebar && !isDesktop && mobileSidebarOpen,
  );

  React.useEffect(() => {
    if (isDesktop) {
      setMobileSidebarOpen(false);
    }
  }, [isDesktop]);

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
        <div
          className={cn(
            "shrink-0",
            contentPadding && "px-4 pt-2 sm:px-6 sm:pt-3 lg:px-7 lg:pt-4",
          )}
        >
          {headerElement}
        </div>
      ) : null}

      <div
        className={cn(
          "flex w-full min-h-0 min-w-0 flex-1 flex-col",
          sidebar && "md:flex-row",
        )}
      >
        {desktopSidebarElement ? (
          <div
            className={cn(
              "hidden min-h-0 w-full shrink-0 items-stretch px-0 pb-0 md:flex md:w-auto",
              contentPadding && "pt-2 sm:pt-3 lg:pt-4",
            )}
          >
            {desktopSidebarElement}
          </div>
        ) : null}

        <main
          ref={(node) => assignRef(contentRef, node)}
          className={cn(
            "chat-native-scrollbar relative flex min-w-0 flex-1 flex-col bg-transparent",
            showMobileSidebarPane ? "overflow-hidden" : "overflow-y-auto",
            contentPadding &&
              !showMobileSidebarPane &&
              "px-4 pb-4 pt-2 sm:px-6 sm:pb-6 sm:pt-3 lg:px-7 lg:pb-7 lg:pt-4",
            !showMobileSidebarPane && contentClassName,
          )}
        >
          {sidebar ? (
            <PageLayoutMobileDrawer
              isDesktop={isDesktop}
              mobileSidebarLabel={mobileSidebarLabel}
              mobileSidebarOpen={mobileSidebarOpen}
              mobileSidebarTriggerClassName={mobileSidebarTriggerClassName}
              onMobileSidebarOpenChange={setMobileSidebarOpen}
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
      </div>
    </div>
  );
}
