"use client";

/**
 * The cloud dashboard sidebar: nav sections plus the mobile drawer dismiss.
 */
import { X } from "lucide-react";
import { memo, type ReactNode, useCallback } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../lib/utils";
import type { AdminRole } from "../../types/cloud-api";
import { DashboardSidebarNavigationSection } from "./dashboard-sidebar-section";
import type {
  DashboardSidebarItem,
  DashboardSidebarLinkRenderer,
  DashboardSidebarSection,
} from "./dashboard-sidebar-types";

export interface DashboardSidebarProps {
  sections: DashboardSidebarSection[];
  activePath: string;
  authenticated: boolean;
  className?: string;
  isOpen?: boolean;
  isAdmin?: boolean;
  adminRole?: AdminRole | null;
  onToggle?: () => void;
  isFeatureEnabled?: (featureFlag: string) => boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  logo?: ReactNode;
  footer?: ReactNode;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}

function DashboardSidebarComponent({
  sections,
  activePath,
  authenticated,
  className,
  isOpen = false,
  isAdmin = false,
  adminRole,
  onToggle,
  isFeatureEnabled,
  renderLink,
  logo,
  footer,
  getLoginHref,
  isItemActive,
}: DashboardSidebarProps) {
  const handleBackdropClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  const handleCloseClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  return (
    <>
      {isOpen && (
        <Button
          variant="ghost"
          type="button"
          aria-label="Close navigation backdrop"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={handleBackdropClick}
        />
      )}

      <aside
        className={cn(
          // Full-viewport column on every breakpoint; the host app locks page
          // scrolling, so the nav list below scrolls internally instead of
          // relying on document scroll (which would strand below-fold items).
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(18rem,calc(100vw-1rem))] flex-col overflow-hidden border-r border-white/14 bg-black p-1.5 transition-transform duration-300 ease-in-out md:static md:z-auto md:w-72 md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full",
          className,
        )}
      >
        <div className="relative mb-2 flex h-14 shrink-0 grow-0 items-center justify-between px-3">
          {logo ? <div className="relative z-10">{logo}</div> : null}
          {onToggle && (
            <Button
              variant="ghost"
              type="button"
              onClick={handleCloseClick}
              className="relative z-10 border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10   md:hidden"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4 text-white" />
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <nav className="px-4 py-6">
            <div className="space-y-8">
              {sections.map((section) => (
                <DashboardSidebarNavigationSection
                  key={
                    section.title ??
                    section.items.map((item) => item.id).join("-")
                  }
                  section={section}
                  activePath={activePath}
                  authenticated={authenticated}
                  isAdmin={isAdmin}
                  adminRole={adminRole}
                  isCollapsed={false}
                  isFeatureEnabled={isFeatureEnabled}
                  renderLink={renderLink}
                  getLoginHref={getLoginHref}
                  isItemActive={isItemActive}
                />
              ))}
            </div>
          </nav>
        </div>

        {footer}
      </aside>
    </>
  );
}

export const DashboardSidebar = memo(DashboardSidebarComponent);
