import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";

declare function ScrollArea({
  className,
  children,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
}): import("react/jsx-runtime").JSX.Element;
declare function ScrollBar({
  className,
  orientation,
  ...props
}: React.ComponentProps<
  typeof ScrollAreaPrimitive.ScrollAreaScrollbar
>): import("react/jsx-runtime").JSX.Element;

export { ScrollArea, ScrollBar };
//# sourceMappingURL=scroll-area.d.ts.map
