import { cn } from "@feed/shared";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";

/**
 * Tabs component root from Radix UI.
 *
 * Main tabs container component. Provides tab navigation functionality.
 */
const Tabs = TabsPrimitive.Root;

/**
 * Tabs list container component.
 *
 * Container for tab triggers with styled background and spacing.
 *
 * @param props - TabsList component props
 * @returns Tabs list element
 */
function TabsList({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
TabsList.displayName = TabsPrimitive.List.displayName;

/**
 * Tabs trigger button component.
 *
 * Individual tab button with active state styling and focus management.
 *
 * @param props - TabsTrigger component props
 * @returns Tabs trigger element
 */
function TabsTrigger({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 font-medium text-sm ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/**
 * Tabs content panel component.
 *
 * Content panel displayed when corresponding tab is active.
 * Includes focus management and ring styling.
 *
 * @param props - TabsContent component props
 * @returns Tabs content element
 */
function TabsContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    />
  );
}
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
