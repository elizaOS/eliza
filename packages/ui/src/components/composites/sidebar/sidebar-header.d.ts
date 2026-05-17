import type * as React from "react";
import type { SidebarSearchBarProps } from "../search";
export interface SidebarHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
    search?: Omit<SidebarSearchBarProps, "className">;
    searchClassName?: string;
}
export declare function SidebarHeader({ children, search, searchClassName, ...props }: SidebarHeaderProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=sidebar-header.d.ts.map