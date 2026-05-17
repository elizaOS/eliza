import type { ReactNode } from "react";
import type { NavItem } from "./docs-types";
export type DocsLayoutProps = {
  children: ReactNode;
  navItems: NavItem[];
  brandLabel?: string;
  brandTo?: string;
};
export declare function DocsLayout({
  children,
  navItems,
  brandLabel,
  brandTo,
}: DocsLayoutProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=docs-layout.d.ts.map
