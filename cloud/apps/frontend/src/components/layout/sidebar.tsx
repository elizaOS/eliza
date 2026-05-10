/**
 * Main sidebar navigation component with responsive mobile support.
 * Memoized to prevent unnecessary re-renders from parent state changes.
 * Always expanded on desktop, toggleable on mobile.
 *
 * @param props - Sidebar configuration
 * @param props.className - Additional CSS classes
 * @param props.isOpen - Whether sidebar is open (mobile)
 * @param props.onToggle - Callback to toggle sidebar visibility
 */

"use client";

import { ElizaCloudLockup, ScrollArea } from "@elizaos/cloud-ui";
import { X } from "lucide-react";
import { memo, useCallback } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { SidebarBottomPanel } from "./sidebar-bottom-panel";
import { sidebarSections } from "./sidebar-data";
import { SidebarNavigationSection } from "./sidebar-section";

interface SidebarProps {
  className?: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

function SidebarComponent({ className, isOpen = false, onToggle }: SidebarProps) {
  const handleBackdropClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  const handleCloseClick = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={handleBackdropClick} />
      )}

      {/* Sidebar Container — fixed drawer on mobile, persistent rail on desktop */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(18rem,calc(100vw-1rem))] flex-col overflow-hidden border-r border-white/10 bg-black/85 p-1.5 backdrop-blur-xl transition-transform duration-300 ease-in-out md:static md:z-auto md:h-full md:w-72 md:translate-x-0 md:bg-black/50",
          isOpen ? "translate-x-0" : "-translate-x-full",
          className,
        )}
      >
        {/* Header with Logo */}
        <div className="relative flex h-14 mb-2 shrink-0 grow-0 items-center justify-between px-3">
          <Link to="/dashboard" className="flex items-center gap-2 hover:opacity-80 relative z-10">
            <ElizaCloudLockup
              logoClassName="h-4 md:h-5"
              textClassName="text-[9px] md:text-[10px]"
            />
          </Link>
          {/* Mobile Close Button */}
          {onToggle && (
            <button
              onClick={handleCloseClick}
              className="relative z-10 border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10 focus:bg-white/10 focus:outline-none md:hidden"
              aria-label="Close navigation"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          )}
        </div>

        {/* Navigation Content */}
        <ScrollArea className="flex-1">
          <nav className="py-6 px-4">
            <div className="space-y-8">
              {sidebarSections.map((section, index) => (
                <SidebarNavigationSection key={index} section={section} isCollapsed={false} />
              ))}
            </div>
          </nav>
        </ScrollArea>

        {/* Bottom Panel with User Info and Settings */}
        <SidebarBottomPanel />
      </aside>
    </>
  );
}

// Memoize the sidebar to prevent re-renders when parent state changes
const Sidebar = memo(SidebarComponent);
export default Sidebar;
