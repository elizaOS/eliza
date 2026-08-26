/**
 * Drawer component system for bottom sheet panels.
 * Built on Vaul library with swipe-to-dismiss and overlay support.
 */
"use client";

import type * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { cn } from "../lib/utils";

function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <Card asChild surface="card" radius="none">
      <DrawerPrimitive.Overlay
        data-slot="drawer-overlay"
        className={cn(
          "theme-cloud fixed inset-0 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </Card>
  );
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <Card asChild surface="card" border="standard" radius="none" tone="text">
        <DrawerPrimitive.Content
          data-slot="drawer-content"
          className={cn(
            // min-h-0 lets DrawerBody shrink within the capped panel and own
            // vertical scrolling instead of clipping tall content.
            "group/drawer-content theme-cloud fixed z-50 flex h-auto min-h-0 flex-col",
            "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh]",
            "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh]",
            "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:sm:max-w-sm",
            "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:sm:max-w-sm",
            className,
          )}
          {...props}
        >
          <DrawerClose asChild>
            <Button
              variant="transparent"
              size="pillDense"
              type="button"
              aria-label="Close drawer"
              className="group mx-auto mb-2 mt-2 hidden w-32 shrink-0 group-data-[vaul-drawer-direction=bottom]/drawer-content:flex"
            >
              <Badge variant="drawerHandle" aria-hidden />
            </Button>
          </DrawerClose>
          {children}
        </DrawerPrimitive.Content>
      </Card>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        // shrink-0 keeps the header fixed while DrawerBody scrolls beneath it.
        "flex shrink-0 flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-left",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The scrollable body of a drawer. Sits between a fixed DrawerHeader and
 * DrawerFooter and takes the remaining height: `flex-1 min-h-0` lets it shrink
 * inside the capped DrawerContent so `overflow-y-auto` actually scrolls (the
 * min-h-0 is what allows a flex child to be shorter than its content), and
 * `overscroll-contain` stops a scroll-to-edge from chaining to the page behind
 * the sheet. Content taller than the drawer scrolls here instead of clipping.
 */
function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-body"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      // shrink-0 keeps the footer pinned to the bottom while DrawerBody scrolls.
      className={cn("mt-auto flex shrink-0 flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
