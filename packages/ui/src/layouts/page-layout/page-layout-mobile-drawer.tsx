import { PanelLeftOpen } from "lucide-react";
import * as React from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { useWorkspaceMobileSidebarControls } from "../workspace-layout/workspace-mobile-sidebar-controls";
import type { PageLayoutMobileDrawerProps } from "./page-layout-types";

export function PageLayoutMobileDrawer({
  isDesktop,
  mobileSidebarLabel,
  mobileSidebarOpen,
  mobileSidebarTriggerClassName,
  onMobileSidebarOpenChange,
  sidebar,
}: PageLayoutMobileDrawerProps) {
  const controls = useWorkspaceMobileSidebarControls();
  const sidebarId = React.useId();

  const mobileSidebarElement = React.cloneElement(sidebar, {
    className: cn("!mt-0 !h-full !w-full !min-w-0", sidebar.props.className),
    collapsible: false,
    variant: "mobile",
    onMobileClose: () => onMobileSidebarOpenChange(false),
  });

  const drawerLabel =
    sidebar.props.mobileTitle ?? mobileSidebarLabel ?? "Browse";

  React.useEffect(() => {
    if (!controls || isDesktop) return undefined;

    return controls.register({
      id: sidebarId,
      label: drawerLabel,
      open: mobileSidebarOpen,
      setOpen: onMobileSidebarOpenChange,
    });
  }, [
    controls,
    drawerLabel,
    isDesktop,
    mobileSidebarOpen,
    onMobileSidebarOpenChange,
    sidebarId,
  ]);

  if (isDesktop) return null;

  return (
    <>
      {!mobileSidebarOpen && !controls ? (
        <div
          className="pointer-events-none fixed left-2 z-40 md:hidden"
          style={{ top: "calc(var(--safe-area-top, 0px) + 2.75rem)" }}
        >
          <div className="pointer-events-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "h-[2.375rem] max-w-[min(11rem,calc(100vw-5.5rem))] rounded-full border-border/40 bg-card/92 px-3 text-sm font-semibold text-txt shadow-sm backdrop-blur-md",
                mobileSidebarTriggerClassName,
              )}
              data-testid="page-layout-mobile-sidebar-trigger"
              onClick={() => onMobileSidebarOpenChange(true)}
            >
              <PanelLeftOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">{drawerLabel}</span>
            </Button>
          </div>
        </div>
      ) : null}
      {mobileSidebarOpen ? (
        <section
          className="flex min-h-0 w-full flex-1 overflow-hidden"
          data-testid="page-layout-mobile-sidebar-drawer"
          aria-label={typeof drawerLabel === "string" ? drawerLabel : undefined}
        >
          {mobileSidebarElement}
        </section>
      ) : null}
    </>
  );
}
