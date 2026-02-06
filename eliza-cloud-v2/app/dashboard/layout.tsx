"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import Sidebar from "@/components/layout/sidebar";
import Header from "@/components/layout/header";
import { PageHeaderProvider } from "@/components/layout/page-header-context";
import { OnboardingProvider, OnboardingOverlay } from "@/components/onboarding";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Free Mode Paths (accessible without auth):
 * - /dashboard/chat - AI agent chat
 * - /dashboard/build - AI agent builder
 */
const FREE_MODE_PATHS = ["/dashboard/chat", "/dashboard/build"];

/**
 * Dashboard layout component that wraps all dashboard pages.
 * Supports both authenticated and anonymous users for free mode paths.
 *
 * Free Mode Paths (accessible without auth):
 * - /dashboard/chat - AI agent chat
 * - /dashboard/build - AI agent builder
 *
 * Protected Paths (require authentication):
 * - All other /dashboard/* routes
 *
 * @param children - The dashboard page content.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { ready, authenticated } = usePrivy();
  const router = useRouter();
  const pathname = usePathname();
  const isAppCreatePage = pathname?.startsWith("/dashboard/apps/create");

  // Memoize toggle callbacks to prevent child re-renders
  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleToggleCollapse = useCallback(() => {
    if (isAppCreatePage) return;
    setSidebarCollapsed((prev) => !prev);
  }, [isAppCreatePage]);

  // Check if current path allows free access
  const isFreeModePath = FREE_MODE_PATHS.some((path) =>
    pathname?.startsWith(path),
  );

  // Redirect to login if not authenticated and trying to access protected path
  // Preserve the current URL as returnTo so users can return after login
  useEffect(() => {
    if (ready && !authenticated && !isFreeModePath) {
      // Build login URL with returnTo parameter to preserve intended destination
      const returnTo = encodeURIComponent(
        pathname +
          (typeof window !== "undefined" ? window.location.search : ""),
      );
      router.replace(`/login?returnTo=${returnTo}`);
    }
  }, [ready, authenticated, isFreeModePath, router, pathname]);

  // Show loading state while checking authentication
  if (!ready) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Allow free mode paths for anonymous users
  // Redirect other paths to home if not authenticated
  if (!authenticated && !isFreeModePath) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Redirecting...</p>
        </div>
      </div>
    );
  }

  // Check if we're on the chat or build page - they have their own custom layout
  const isCustomLayoutPage =
    pathname?.startsWith("/dashboard/chat") ||
    pathname?.startsWith("/dashboard/build");

  // Pages that need full width without padding
  const isFullWidthPage = isAppCreatePage;
  const isSidebarCollapsed = isAppCreatePage ? true : sidebarCollapsed;

  // For chat/build pages, render children directly without standard layout
  if (isCustomLayoutPage) {
    return (
      <OnboardingProvider>
        <PageHeaderProvider>{children}</PageHeaderProvider>
        <OnboardingOverlay />
      </OnboardingProvider>
    );
  }

  // Standard dashboard layout for all other pages
  return (
    <OnboardingProvider>
      <PageHeaderProvider>
        <div className="flex h-screen w-full bg-neutral-900 x ">
          {/* Sidebar */}
          <Sidebar
            isOpen={sidebarOpen}
            onToggle={handleToggleSidebar}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={handleToggleCollapse}
          />

          {/* Main Content */}
          <div className="flex flex-1 max-md:pl-3 py-3 pr-3 flex-col overflow-hidden gap-1.5 md:gap-3">
            {/* Header - pass auth state for signup button */}
            <Header
              onToggleSidebar={handleToggleSidebar}
              isAnonymous={!authenticated}
            />

            {/* Main Content Area */}
            <ScrollArea className="flex-1 bg-black rounded-2xl min-w-0">
              <main className="p-3 md:p-6 w-0 min-w-full overflow-hidden">
                {children}
              </main>
            </ScrollArea>
          </div>
        </div>
      </PageHeaderProvider>
      <OnboardingOverlay />
    </OnboardingProvider>
  );
}
