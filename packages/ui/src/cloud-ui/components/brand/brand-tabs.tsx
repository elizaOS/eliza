/**
 * Brand tabs: flat, token-driven, with bottom-border active state.
 * Requires a unique `id` on the consumer to avoid hydration mismatches when used in pairs.
 */

"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../../lib/utils";

const BrandTabs = TabsPrimitive.Root;

const BrandTabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-sm border border-border bg-bg-elevated p-0",
      className,
    )}
    {...props}
  />
));
BrandTabsList.displayName = TabsPrimitive.List.displayName;

const BrandTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center gap-2 rounded-none px-6 py-1.5 text-sm font-medium transition-colors whitespace-nowrap",
      "border-b-2 border-transparent text-txt/70 hover:text-txt",
      "data-[state=active]:border-txt data-[state=active]:bg-bg-hover data-[state=active]:text-txt",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      "disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
BrandTabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const BrandTabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-8 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
BrandTabsContent.displayName = TabsPrimitive.Content.displayName;

interface SimpleBrandTabsProps {
  tabs: string[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  className?: string;
}

export function SimpleBrandTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
}: SimpleBrandTabsProps) {
  return (
    <div className={cn("flex flex-wrap gap-0", className)}>
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab}
          onClick={() => onTabChange(tab)}
          className={cn("brand-tab", activeTab === tab && "brand-tab-active")}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

export { BrandTabs, BrandTabsContent, BrandTabsList, BrandTabsTrigger };
