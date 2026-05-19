import type * as React from "react";
import { Button } from "../../ui/button";
export interface SidebarCollapsedRailProps extends React.HTMLAttributes<HTMLDivElement> {
    action?: React.ReactNode;
    listClassName?: string;
}
export declare function SidebarCollapsedRail({ action, children, className, listClassName, ...props }: SidebarCollapsedRailProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarCollapsedActionButtonProps extends React.ComponentProps<typeof Button> {
}
export declare function SidebarCollapsedActionButton({ className, size, variant, ...props }: SidebarCollapsedActionButtonProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=sidebar-collapsed-rail.d.ts.map