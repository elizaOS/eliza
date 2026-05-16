/**
 * Brand Tabs Responsive Component
 * Automatically switches between tabs (desktop) and dropdown (mobile)
 *
 * IMPORTANT: Always provide a unique `id` prop to prevent hydration errors
 *
 * @example
 * <BrandTabsResponsive
 *   id="my-tabs"
 *   tabs={[
 *     { value: "tab1", label: "Tab 1", icon: <Icon /> },
 *     { value: "tab2", label: "Tab 2", icon: <Icon /> }
 *   ]}
 *   value={activeTab}
 *   onValueChange={setActiveTab}
 * >
 *   <BrandTabsContent value="tab1">Content 1</BrandTabsContent>
 *   <BrandTabsContent value="tab2">Content 2</BrandTabsContent>
 * </BrandTabsResponsive>
 */

"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";
import { BrandTabsContent } from "./brand-tabs";

export interface TabItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface BrandTabsResponsiveProps {
  id: string;
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
  breakpoint?: "sm" | "md" | "lg"; // Tailwind breakpoint for switching
}

export function BrandTabsResponsive({
  id,
  tabs,
  value,
  defaultValue,
  onValueChange,
  children,
  className,
  breakpoint = "md", // Default to medium breakpoint
}: BrandTabsResponsiveProps) {
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  // Prevent hydration mismatch by not rendering until mounted
  if (!isMounted) {
    return null;
  }

  return (
    <TabsPrimitive.Root
      id={id}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      className={cn("w-full", className)}
    >
      {/* Mobile Dropdown - Hidden on desktop */}
      <div
        className={cn(
          "block",
          breakpoint === "sm" && "sm:hidden",
          breakpoint === "md" && "md:hidden",
          breakpoint === "lg" && "lg:hidden",
        )}
      >
        <Select value={value || defaultValue} onValueChange={onValueChange}>
          <SelectTrigger
            className={cn(
              "w-full h-8 rounded-sm border border-border bg-bg-elevated",
              "text-txt text-xs px-3 py-1",
              "hover:bg-bg-hover transition-colors",
            )}
          >
            <SelectValue>
              {tabs.find((tab) => tab.value === (value || defaultValue))?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-bg-elevated border-border">
            {tabs.map((tab) => (
              <SelectItem
                key={tab.value}
                value={tab.value}
                disabled={tab.disabled}
                className={cn(
                  "text-txt text-xs cursor-pointer",
                  "hover:bg-bg-hover focus:bg-bg-hover",
                  "data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
                )}
              >
                <div className="flex items-center gap-2">
                  {tab.icon}
                  {tab.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop Tabs - Hidden on mobile */}
      <TabsPrimitive.List
        className={cn(
          "hidden",
          breakpoint === "sm" && "sm:inline-flex",
          breakpoint === "md" && "md:inline-flex",
          breakpoint === "lg" && "lg:inline-flex",
          "h-8 lg:h-9 items-center justify-center rounded-sm bg-bg-elevated border border-border p-0",
        )}
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className={cn(
              "inline-flex items-center gap-1.5 lg:gap-2 rounded-none px-2.5 lg:px-4 xl:px-6 py-1 lg:py-1.5 text-xs lg:text-sm font-medium transition-colors whitespace-nowrap",
              "border-b-2 border-transparent",
              "text-txt/70 hover:text-txt",
              "data-[state=active]:border-txt data-[state=active]:bg-bg-hover data-[state=active]:text-txt",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span className="[&>svg]:h-3.5 [&>svg]:w-3.5 lg:[&>svg]:h-4 lg:[&>svg]:w-4">
              {tab.icon}
            </span>
            <span className="hidden lg:inline">{tab.label}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      {/* Content */}
      {children}
    </TabsPrimitive.Root>
  );
}

export { BrandTabsContent };
