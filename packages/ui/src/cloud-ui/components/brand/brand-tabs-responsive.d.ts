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
import * as React from "react";
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
    breakpoint?: "sm" | "md" | "lg";
}
export declare function BrandTabsResponsive({ id, tabs, value, defaultValue, onValueChange, children, className, breakpoint, }: BrandTabsResponsiveProps): import("react/jsx-runtime").JSX.Element | null;
export { BrandTabsContent };
//# sourceMappingURL=brand-tabs-responsive.d.ts.map