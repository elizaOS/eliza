import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const textVariants = cva("text-txt", {
  variants: {
    variant: {
      default: "text-base",
      medium: "text-sm",
      small: "text-xs",
      muted: "text-sm text-muted",
      lead: "text-xl text-muted",
      large: "text-lg font-semibold",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface TextProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof textVariants> {
  asChild?: boolean;
}

export const Text = React.forwardRef<HTMLParagraphElement, TextProps>(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Comp = asChild ? "span" : "p";
    return (
      <Comp
        ref={ref}
        className={cn(textVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
Text.displayName = "Text";

const headingVariants = cva("text-txt font-semibold tracking-tight", {
  variants: {
    level: {
      h1: "text-4xl font-extrabold lg:text-5xl",
      h2: "text-3xl",
      h3: "text-2xl",
      h4: "text-xl",
      h5: "text-lg",
      h6: "text-base",
    },
  },
  defaultVariants: {
    level: "h1",
  },
});

export interface HeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof headingVariants> {}

export const Heading = React.forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ className, level = "h1", ...props }, ref) => {
    const Comp = level ?? "h1";
    return (
      <Comp
        ref={ref}
        className={cn(headingVariants({ level }), className)}
        {...props}
      />
    );
  },
);
Heading.displayName = "Heading";
