import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const buttonVariants: (
  props?:
    | ({
        variant?:
          | "default"
          | "surface"
          | "surfaceAccent"
          | "surfaceDestructive"
          | "destructive"
          | "outline"
          | "secondary"
          | "ghost"
          | "link"
          | null
          | undefined;
        size?:
          | "default"
          | "sm"
          | "lg"
          | "icon"
          | "icon-sm"
          | "icon-lg"
          | null
          | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
declare const Button: React.ForwardRefExoticComponent<
  ButtonProps & React.RefAttributes<HTMLButtonElement>
>;

export { Button, buttonVariants };
//# sourceMappingURL=button.d.ts.map
