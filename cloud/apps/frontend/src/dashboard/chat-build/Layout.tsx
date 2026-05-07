import { Menu } from "lucide-react";
import { useCallback, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ChatSidebar } from "@elizaos/cloud-ui/components/layout/chat-sidebar";

/**
 * Shared layout for `/dashboard/chat` and `/dashboard/build`.
 * Fullscreen layout with a chat sidebar that's hidden on the build page.
 * The parent DashboardLayout already detects these routes as free-mode and
 * skips its own sidebar/header chrome, so this layout owns the entire viewport.
 */
export default function ChatBuildLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = useLocation().pathname;

  const isBuildPage = pathname?.startsWith("/dashboard/build");

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  return (
    <div className="dashboard-theme flex h-dvh min-h-dvh w-full overflow-hidden bg-neutral-950">
      {!isBuildPage && <ChatSidebar isOpen={sidebarOpen} onToggle={handleToggleSidebar} />}

      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {!isBuildPage && (
          <button
            onClick={handleToggleSidebar}
            className="fixed left-4 top-4 z-30 border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10 md:hidden"
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5 text-white" />
          </button>
        )}

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
