/**
 * Tabs primitives over Radix `@radix-ui/react-tabs` (list, trigger, content),
 * themed to the kit tokens. Derived from shadcn/ui `tabs`
 * (https://ui.shadcn.com/docs/components/tabs).
 */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva(
  "inline-flex items-center justify-center rounded-sm text-muted",
  {
    variants: {
      variant: {
        default: "h-10 bg-bg-accent p-1",
        brand: "h-9 border border-border bg-bg-elevated p-0",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const tabsTriggerVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-sm text-sm font-medium disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "px-3 py-1.5 transition-[background-color,color] data-[state=active]:bg-bg data-[state=active]:text-txt",
        brand:
          "gap-2 border-b-2 border-transparent px-6 py-1.5 text-txt/70 transition-colors hover:text-txt data-[state=active]:border-accent data-[state=active]:bg-bg-hover data-[state=active]:text-txt",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface TabsListProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, variant, ...props }, ref) => (
    <TabsPrimitive.List
      ref={ref}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  ),
);
TabsList.displayName = TabsPrimitive.List.displayName;

export interface TabsTriggerProps
  extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, variant, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  ),
);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-2     ", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
