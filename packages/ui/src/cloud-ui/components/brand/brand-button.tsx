/**
 * Brand button: flat fills, theme-token driven, xs rounding.
 *
 * @param props.asChild - If true, renders as a child component using Radix Slot
 */

import * as React from "react";
import { Button, type ButtonProps } from "../../../components/ui/button";

export interface BrandButtonProps
  extends Omit<ButtonProps, "variant" | "size"> {
  variant?:
    | "primary"
    | "primaryBilling"
    | "ghost"
    | "outline"
    | "icon"
    | "icon-primary";
  size?: "sm" | "md" | "lg" | "icon";
}

const BrandButton = React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  ({ variant = "primary", size = "md", disabled, ...props }, ref) => (
    <Button
      ref={ref}
      variant={
        variant === "primary"
          ? "default"
          : variant === "primaryBilling"
            ? disabled
              ? "outline"
              : "default"
            : variant === "icon-primary"
              ? "surfaceAccent"
              : variant === "icon"
                ? "surface"
                : variant
      }
      size={
        variant === "icon" || variant === "icon-primary" || size === "icon"
          ? "icon"
          : size === "md"
            ? "default"
            : size
      }
      disabled={disabled}
      {...props}
    />
  ),
);

BrandButton.displayName = "BrandButton";

export { BrandButton };
