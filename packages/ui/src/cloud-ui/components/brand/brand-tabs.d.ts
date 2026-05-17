/**
 * Brand tabs: flat, token-driven, with bottom-border active state.
 * Requires a unique `id` on the consumer to avoid hydration mismatches when used in pairs.
 */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

declare const BrandTabs: React.ForwardRefExoticComponent<
  TabsPrimitive.TabsProps & React.RefAttributes<HTMLDivElement>
>;
declare const BrandTabsList: React.ForwardRefExoticComponent<
  Omit<
    TabsPrimitive.TabsListProps & React.RefAttributes<HTMLDivElement>,
    "ref"
  > &
    React.RefAttributes<HTMLDivElement>
>;
declare const BrandTabsTrigger: React.ForwardRefExoticComponent<
  Omit<
    TabsPrimitive.TabsTriggerProps & React.RefAttributes<HTMLButtonElement>,
    "ref"
  > &
    React.RefAttributes<HTMLButtonElement>
>;
declare const BrandTabsContent: React.ForwardRefExoticComponent<
  Omit<
    TabsPrimitive.TabsContentProps & React.RefAttributes<HTMLDivElement>,
    "ref"
  > &
    React.RefAttributes<HTMLDivElement>
>;
interface SimpleBrandTabsProps {
  tabs: string[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  className?: string;
}
export declare function SimpleBrandTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
}: SimpleBrandTabsProps): import("react/jsx-runtime").JSX.Element;
export { BrandTabs, BrandTabsContent, BrandTabsList, BrandTabsTrigger };
//# sourceMappingURL=brand-tabs.d.ts.map
