import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const stackVariants: (
  props?:
    | ({
        direction?: "col" | "row" | null | undefined;
        align?:
          | "start"
          | "end"
          | "center"
          | "stretch"
          | "baseline"
          | null
          | undefined;
        justify?: "start" | "end" | "center" | "between" | null | undefined;
        spacing?: "none" | "sm" | "lg" | "md" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface StackProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof stackVariants> {}
export declare const Stack: React.ForwardRefExoticComponent<
  StackProps & React.RefAttributes<HTMLDivElement>
>;
//# sourceMappingURL=stack.d.ts.map
