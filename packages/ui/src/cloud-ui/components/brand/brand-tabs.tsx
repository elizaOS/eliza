/**
 * Brand tabs: flat, token-driven, with bottom-border active state.
 * Requires a unique `id` on the consumer to avoid hydration mismatches when used in pairs.
 */

"use client";

import * as React from "react";
import { Button } from "../../../components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import { cn } from "../../lib/utils";

const BrandTabs = Tabs;

const BrandTabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsList>
>(({ className, ...props }, ref) => (
  <TabsList ref={ref} variant="brand" className={className} {...props} />
));
BrandTabsList.displayName = "BrandTabsList";

const BrandTabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TabsTrigger>
>(({ className, ...props }, ref) => (
  <TabsTrigger ref={ref} variant="brand" className={className} {...props} />
));
BrandTabsTrigger.displayName = "BrandTabsTrigger";

const BrandTabsContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsContent>
>(({ className, ...props }, ref) => (
  <TabsContent ref={ref} className={cn("mt-8", className)} {...props} />
));
BrandTabsContent.displayName = "BrandTabsContent";

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
        <Button
          variant="ghost"
          type="button"
          key={tab}
          onClick={() => onTabChange(tab)}
          className={cn("brand-tab", activeTab === tab && "brand-tab-active")}
        >
          {tab}
        </Button>
      ))}
    </div>
  );
}

export { BrandTabs, BrandTabsContent, BrandTabsList, BrandTabsTrigger };
