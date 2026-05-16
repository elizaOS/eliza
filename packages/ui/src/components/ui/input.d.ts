import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const inputVariants: (
  props?:
    | ({
        variant?: "default" | "form" | "config" | null | undefined;
        density?: "default" | "compact" | "relaxed" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {
  hasError?: boolean;
}
declare const Input: React.ForwardRefExoticComponent<
  InputProps & React.RefAttributes<HTMLInputElement>
>;

export { Input, inputVariants };
//# sourceMappingURL=input.d.ts.map
