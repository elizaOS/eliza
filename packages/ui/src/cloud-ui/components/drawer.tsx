/**
 * Drawer component system for bottom sheet panels.
 * Built on Vaul library with swipe-to-dismiss and overlay support.
 */
"use client";

import type * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { Button } from "../../components/ui/button";
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
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn(
        // A genuine scrim: deep, warm-tinted, and blurred so nothing behind the
        // sheet reads through it (the prior bg-black/50 let content bleed). The
        // brand palette is black/white/orange only, so the scrim is the brand
        // black at 72% rather than an off-palette "ember" rgba.
        // Solid bg-scrim token: the opaque scrim already hides content behind
        // the sheet, so no blur filter is needed (flat system + battery gate).
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-scrim",
        className,
      )}
      {...props}
    />
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
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          // SOLID warm-dark surface so the sheet is fully opaque over the field
          // (no see-through). `bg-card` resolves to --surface-1 (--surface-1) in the
          // dark theme — same value, now a token instead of a hardcode.
          //
          // min-h-0 is load-bearing: it lets a `DrawerBody` flex child shrink
          // below its content height so its own overflow-y-auto can scroll. A
          // vaul content that only capped max-h without a scroll region clipped
          // any content taller than the cap (the drawer-unscrollable bug).
          "group/drawer-content fixed z-50 flex h-auto min-h-0 flex-col bg-card text-txt shadow-[0_-12px_48px_-12px_rgba(0,0,0,0.75)]",
          "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=top]:border-border",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=bottom]:border-border",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:border-border data-[vaul-drawer-direction=right]:sm:max-w-sm",
          "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=left]:border-border data-[vaul-drawer-direction=left]:sm:max-w-sm",
          className,
        )}
        {...props}
      >
        <DrawerClose asChild>
          <Button
            variant="ghost"
            type="button"
            aria-label="Close drawer"
            className="group mx-auto mb-2 mt-2 hidden h-8 w-32 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-bg-hover group-data-[vaul-drawer-direction=bottom]/drawer-content:flex"
          >
            <span
              className="h-1.5 w-[100px] rounded-full bg-border transition-all group-hover:w-[112px] group-hover:bg-border-strong"
              aria-hidden
            />
          </Button>
        </DrawerClose>
        {children}
      </DrawerPrimitive.Content>
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
