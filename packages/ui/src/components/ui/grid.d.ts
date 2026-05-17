import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const gridVariants: (
  props?:
    | ({
        columns?: 3 | 1 | 2 | 4 | 12 | 6 | null | undefined;
        spacing?: "none" | "sm" | "lg" | "md" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface GridProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof gridVariants> {}
export declare const Grid: React.ForwardRefExoticComponent<
  GridProps & React.RefAttributes<HTMLDivElement>
>;
//# sourceMappingURL=grid.d.ts.map
