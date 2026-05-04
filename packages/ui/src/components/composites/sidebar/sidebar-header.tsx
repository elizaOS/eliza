import type * as React from "react";

import type { SidebarSearchBarProps } from "../search";
import { SidebarSearchBar } from "../search";
import { SidebarHeaderStack } from "./sidebar-header-stack";

export interface SidebarHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  search?: Omit<SidebarSearchBarProps, "className">;
  searchClassName?: string;
}

export function SidebarHeader({
  children,
  search,
  searchClassName,
  ...props
}: SidebarHeaderProps) {
  return (
    <SidebarHeaderStack {...props}>
      {search ? (
        <SidebarSearchBar className={searchClassName} {...search} />
      ) : null}
      {children}
    </SidebarHeaderStack>
  );
}
