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
      <div className="mb-3 flex items-center md:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-11 rounded-2xl px-4 text-sm font-semibold shadow-sm",
            mobileSidebarTriggerClassName,
          )}
          onClick={() => onMobileSidebarOpenChange(true)}
        >
          <PanelLeftOpen className="h-4 w-4" />
          {drawerLabel}
        </Button>
      </div>
      <DrawerSheet
        open={mobileSidebarOpen}
        onOpenChange={onMobileSidebarOpenChange}
      >
        <DrawerSheetContent
          aria-describedby={undefined}
          className="h-[min(calc(100dvh-1rem-var(--safe-area-top,0px)-var(--safe-area-bottom,0px)),46rem)] p-0"
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
