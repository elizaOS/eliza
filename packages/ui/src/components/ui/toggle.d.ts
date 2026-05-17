import * as TogglePrimitive from "@radix-ui/react-toggle";
import { type VariantProps } from "class-variance-authority";
import type * as React from "react";

declare const toggleVariants: (
  props?:
    | ({
        variant?: "default" | "outline" | null | undefined;
        size?: "default" | "sm" | "lg" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
declare function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>): import("react/jsx-runtime").JSX.Element;

export { Toggle, toggleVariants };
//# sourceMappingURL=toggle.d.ts.map
