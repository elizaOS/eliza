/**
 * Surface container primitive plus its slot parts (Header, Title, Description,
 * Action, Content, Footer). cva variants select behaviour/padding: default,
 * interactive (hover-affordance), status, setting, flat.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const cardVariants = cva("rounded-sm bg-card/70 text-card-fg", {
  variants: {
    variant: {
      default: "",
      interactive: "transition-colors hover:bg-card cursor-pointer",
      setting: "p-0",
      flatPadded: "p-4",
      brand: "relative border border-border bg-bg-elevated p-4 text-txt md:p-6",
      panel: "border border-border/60 bg-card/92",
      overlayWide:
        "relative z-10 w-full max-w-[820px] overflow-hidden border border-border/60 bg-card/95",
      overlayMedium:
        "relative z-10 w-full max-w-[640px] overflow-hidden border border-border/60 bg-card/95",
      pairingGate:
        "relative z-10 w-full max-w-[620px] overflow-hidden border border-border/60 bg-card/95",
      startupFailure:
        "relative z-10 w-full max-w-[720px] overflow-hidden border border-border/60 bg-card/95",
      cloudPayment: "border border-border bg-card text-card-fg",
      cloudPaymentPublic:
        "rounded-xs border border-inverse-foreground/12 bg-inverse/88 text-inverse-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  asChild?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ asChild = false, className, variant, ...props }, ref) => {
    const Component = asChild ? Slot : "div";
    return (
      <Component
        ref={ref}
        className={cn(cardVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-action"
    className={cn(
      "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
      className,
    )}
    {...props}
  />
));
CardAction.displayName = "CardAction";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
};
