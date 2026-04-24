import { PanelLeftOpen } from "lucide-react";
import * as React from "react";

import { Button } from "../../components/ui/button";
import {
  DrawerSheet,
  DrawerSheetContent,
  DrawerSheetHeader,
  DrawerSheetTitle,
} from "../../components/ui/drawer-sheet";
import { cn } from "../../lib/utils";
import type { PageLayoutMobileDrawerProps } from "./page-layout-types";

export function PageLayoutMobileDrawer({
  isDesktop,
  mobileSidebarLabel,
  mobileSidebarOpen,
  mobileSidebarTriggerClassName,
  onMobileSidebarOpenChange,
  sidebar,
}: PageLayoutMobileDrawerProps) {
  if (isDesktop) return null;

  const mobileSidebarElement = React.cloneElement(sidebar, {
    className: cn("!mt-0 !h-full !w-full !min-w-0", sidebar.props.className),
    collapsible: false,
    variant: "mobile",
    onMobileClose: () => onMobileSidebarOpenChange(false),
  });

  const drawerLabel =
    sidebar.props.mobileTitle ?? mobileSidebarLabel ?? "Browse";

  return (
    <>
      {!mobileSidebarOpen ? (
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
      <DrawerSheet
        open={mobileSidebarOpen}
        onOpenChange={onMobileSidebarOpenChange}
      >
        <DrawerSheetContent
          aria-describedby={undefined}
          className="!inset-0 !left-0 !right-0 !bottom-0 !top-0 !h-[100dvh] !max-h-none !rounded-none !border-0 p-0"
          data-testid="page-layout-mobile-sidebar-drawer"
          showCloseButton={false}
        >
          <DrawerSheetHeader className="sr-only">
            <DrawerSheetTitle>{drawerLabel}</DrawerSheetTitle>
          </DrawerSheetHeader>
          {mobileSidebarElement}
        </DrawerSheetContent>
      </DrawerSheet>
    </>
  );
}
