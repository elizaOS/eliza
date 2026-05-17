import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const textVariants: (
  props?:
    | ({
        variant?:
          | "medium"
          | "default"
          | "small"
          | "muted"
          | "lead"
          | "large"
          | null
          | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface TextProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof textVariants> {
  asChild?: boolean;
}
export declare const Text: React.ForwardRefExoticComponent<
  TextProps & React.RefAttributes<HTMLParagraphElement>
>;
declare const headingVariants: (
  props?:
    | ({
        level?: "h2" | "h3" | "h1" | "h4" | "h5" | "h6" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface HeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof headingVariants> {}
export declare const Heading: React.ForwardRefExoticComponent<
  HeadingProps & React.RefAttributes<HTMLHeadingElement>
>;
//# sourceMappingURL=typography.d.ts.map
