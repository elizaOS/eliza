/**
 * Main sidebar navigation component with responsive mobile support.
 * Memoized to prevent unnecessary re-renders from parent state changes.
 *
 * @param props - Sidebar configuration
 * @param props.className - Additional CSS classes
 * @param props.isOpen - Whether sidebar is open (mobile)
 * @param props.onToggle - Callback to toggle sidebar visibility
 */

"use client";

import Link from "next/link";
import { useState, useEffect, memo, useCallback } from "react";
import { X, PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarNavigationSection } from "./sidebar-section";
import { sidebarSections } from "./sidebar-data";
import { SidebarBottomPanel } from "./sidebar-bottom-panel";
import { ElizaLogo } from "@/components/brand";

interface SidebarProps {
  className?: string;
  isOpen?: boolean;
  onToggle?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

function SidebarComponent({
  className,
  isOpen = false,
  onToggle,
  isCollapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkScreenSize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkScreenSize();
    window.addEventListener("resize", checkScreenSize);
    return () => window.removeEventListener("resize", checkScreenSize);
  }, []);

  // Memoize toggle handler
  const handleBackdropClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  const handleCloseClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  return (
    <>
      {/* Mobile Backdrop */}
      {isMobile && isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={handleBackdropClick}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={cn(
          "flex h-full flex-col overflow-hidden transition-all duration-300 ease-in-out",
          isMobile
            ? `fixed bg-neutral-900 x  inset-y-0 left-0 z-50 w-72 p-1.5 ${isOpen ? "translate-x-0" : "-translate-x-full"}`
            : isCollapsed
              ? "w-14 p-1.5"
              : "w-72 p-1.5",
          className,
        )}
      >
        {/* Header with Logo and Collapse Toggle */}
        <div
          className={cn(
            "relative flex h-14 mb-2 shrink-0 grow-0 items-center overflow-visible",
            isCollapsed ? "justify-center px-0" : "justify-between px-3",
          )}
        >
          {!isCollapsed && (
            <Link
              href="/dashboard"
              className="flex items-center gap-2 hover:opacity-80 relative z-10"
            >
              <ElizaLogo
                className={`text-white shrink-0 ${isMobile ? "h-4" : "h-5"}`}
              />
            </Link>
          )}
          {/* Collapse Toggle Button (Desktop) */}
          {!isMobile && onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isCollapsed ? (
                <PanelLeft className="h-5 w-5 text-neutral-300" />
              ) : (
                <PanelLeftClose className="h-5 w-5 text-neutral-300" />
              )}
            </button>
          )}
          {/* Mobile Close Button */}
          {isMobile && onToggle && (
            <button
              onClick={handleCloseClick}
              className="rounded-lg p-2 hover:bg-white/10 focus:bg-white/10 focus:outline-none relative z-10 transition-colors"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          )}
        </div>

        {/* Navigation Content */}
        <ScrollArea className="flex-1">
          <nav className={cn("py-6", isCollapsed ? "px-1" : "px-4")}>
            <div className={isCollapsed ? "space-y-2" : "space-y-8"}>
              {sidebarSections.map((section, index) => (
                <SidebarNavigationSection
                  key={index}
                  section={section}
                  isCollapsed={isCollapsed}
                />
              ))}
            </div>
          </nav>
        </ScrollArea>

        {/* Bottom Panel with User Info and Settings - hidden when collapsed */}
        {!isCollapsed && <SidebarBottomPanel />}
      </aside>
    </>
  );
}

// Memoize the sidebar to prevent re-renders when parent state changes
const Sidebar = memo(SidebarComponent);
export default Sidebar;
