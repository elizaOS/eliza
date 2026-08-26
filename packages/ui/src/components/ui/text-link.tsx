/** Canonical semantic anchor with typed inline-link presentations. */
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const textLinkVariants = cva("", {
  variants: {
    variant: {
      instruction:
        "select-all break-all text-xs font-medium text-txt underline underline-offset-2 hover:text-muted",
      accent: "font-medium text-accent underline",
    },
  },
  defaultVariants: { variant: "accent" },
});

export interface TextLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof textLinkVariants> {}

export const TextLink = React.forwardRef<HTMLAnchorElement, TextLinkProps>(
  ({ className, variant, ...props }, ref) => (
    <a
      ref={ref}
      className={cn(textLinkVariants({ variant }), className)}
      {...props}
    />
  ),
);
TextLink.displayName = "TextLink";

export { textLinkVariants };
