/**
 * Custom-scrollbar scroll container over Radix `@radix-ui/react-scroll-area`,
 * with horizontal and vertical bars. Derived from shadcn/ui `scroll-area`
 * (https://ui.shadcn.com/docs/components/scroll-area).
 */
"use client";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const scrollAreaVariants = cva("relative overflow-hidden", {
  variants: {
    variant: {
      default: "",
      storyVertical: "h-48 w-56 rounded-md border",
      storyHorizontal: "w-72 rounded-md border whitespace-nowrap",
      storyLongText: "h-40 w-80 rounded-md border",
      bordered: "rounded-sm border border-border/60",
      borderedSquare: "rounded-none border border-border",
    },
  },
  defaultVariants: { variant: "default" },
});

function ScrollArea({
  className,
  children,
  viewportClassName,
  variant,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
} & VariantProps<typeof scrollAreaVariants>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn(scrollAreaVariants({ variant }), className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        tabIndex={0}
        data-slot="scroll-area-viewport"
        className={cn(
          " h-full w-full rounded-[inherit] transition-[color,box-shadow] outline-none  ",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-sm"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
