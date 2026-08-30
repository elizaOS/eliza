/**
 * Horizontal/vertical divider over Radix `@radix-ui/react-separator`. Derived
 * from shadcn/ui `separator` (https://ui.shadcn.com/docs/components/separator).
 */
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as React from "react";

import { cn } from "../../lib/utils";

interface SeparatorProps
  extends React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  tone?: "default" | "subtle40" | "subtle45" | "resizeHandle";
  layoutStyle?: Pick<
    React.CSSProperties,
    "alignSelf" | "flex" | "height" | "width"
  >;
}

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  SeparatorProps
>(
  (
    {
      className,
      layoutStyle,
      orientation = "horizontal",
      style,
      decorative = true,
      tone = "default",
      ...props
    },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      style={{ ...style, ...layoutStyle }}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        tone === "subtle40" && "bg-border/40",
        tone === "subtle45" && "bg-border/45",
        tone === "resizeHandle" &&
          "bg-transparent transition-colors hover:bg-accent/20",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
