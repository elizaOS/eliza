/**
 * Chat/Build Shared Layout
 * Fullscreen layout for /chat and /build pages with sidebar
 * Sidebar is hidden in build mode (both creator and edit modes)
 */

"use client";

import { useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { ChatSidebar } from "@/components/layout/chat-sidebar";

/**
 * Shared layout component for chat and build pages.
 * Provides a fullscreen layout with sidebar navigation.
 * Sidebar is only shown on chat pages, hidden on build pages.
 *
 * @param children - The page content to render.
 * @returns The rendered layout with sidebar and content area.
 */
export default function ChatBuildLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const pathname = usePathname();

  // Hide sidebar on build pages (creator mode and edit mode)
  const isBuildPage = pathname?.startsWith("/dashboard/build");

  // Memoize toggle callbacks to prevent child re-renders
  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="flex h-screen w-full bg-neutral-900 x  overflow-hidden">
      {/* Chat Sidebar - hidden in build mode */}
      {!isBuildPage && (
        <ChatSidebar
          isOpen={sidebarOpen}
          onToggle={handleToggleSidebar}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleCollapse}
        />
      )}

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden relative">
        {/* Mobile Menu Button - only on chat pages */}
        {!isBuildPage && (
          <button
            onClick={handleToggleSidebar}
            className="md:hidden fixed top-4 left-4 z-30 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5 text-white" />
          </button>
        )}

        {/* Content Area - Full Height */}
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
