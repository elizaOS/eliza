import "../../styles/docs.css";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { NavItem } from "./docs-types";

function isActivePath(itemPath: string, current: string): boolean {
  return current === itemPath || current.startsWith(`${itemPath}/`);
}

function NavItems({ items, current }: { items: NavItem[]; current: string }) {
  return (
    <ul className="docs-nav-list">
      {items.map((item) => {
        if (item.kind === "separator") {
          return (
            <li key={item.id} className="docs-nav-separator">
              {item.title}
            </li>
          );
        }
        if (item.kind === "section") {
          return (
            <li key={item.slug} className="docs-nav-section">
              <Link
                to={item.path}
                className={`docs-nav-section-title${
                  isActivePath(item.path, current) ? " active" : ""
                }`}
              >
                {item.title}
              </Link>
              <NavItems items={item.children} current={current} />
            </li>
          );
        }
        return (
          <li key={`${item.path}-${item.slug}`}>
            <Link
              to={item.path}
              className={`docs-nav-link${current === item.path ? " active" : ""}`}
            >
              {item.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export type DocsLayoutProps = {
  children: ReactNode;
  navItems: NavItem[];
  brandLabel?: string;
  brandTo?: string;
};

export function DocsLayout({
  children,
  navItems,
  brandLabel = "Eliza Cloud Docs",
  brandTo = "/docs",
}: DocsLayoutProps) {
  const { pathname } = useLocation();
  const current = pathname.replace(/\/$/, "") || "/docs";
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <Link to={brandTo} className="docs-sidebar-brand">
          {brandLabel}
        </Link>
        <nav aria-label="Docs navigation">
          <NavItems items={navItems} current={current} />
        </nav>
      </aside>
      <main className="docs-main">{children}</main>
    </div>
  );
}
