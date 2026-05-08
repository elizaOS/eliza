import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { DashboardLoadingState } from "@elizaos/cloud-ui/components/dashboard/route-placeholders";
import { OnboardingOverlay } from "../onboarding/onboarding-overlay";
import { OnboardingProvider } from "../onboarding/onboarding-provider";
import { ScrollArea } from "@elizaos/cloud-ui/components/scroll-area";
import Header from "./header";
import { PageHeaderProvider } from "@elizaos/cloud-ui/primitives";
import Sidebar from "./sidebar";

export type DashboardShellProps = {
  authReady: boolean;
  /** When set, renders `<Navigate replace />` */
  loginRedirectTo?: string;
  /** Chat — onboarding + outlet only */
  minimalOutletChrome: boolean;
  headerAnonymous: boolean;
  headerAuthGraceActive: boolean;
};

export function DashboardShell({
  authReady,
  loginRedirectTo,
  minimalOutletChrome,
  headerAnonymous,
  headerAuthGraceActive,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  if (!authReady) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (loginRedirectTo) {
    return <Navigate to={loginRedirectTo} replace />;
  }

  if (minimalOutletChrome) {
    return (
      <OnboardingProvider>
        <PageHeaderProvider>
          <Suspense fallback={<DashboardLoadingState />}>
            <Outlet />
          </Suspense>
        </PageHeaderProvider>
        <OnboardingOverlay />
      </OnboardingProvider>
    );
  }

  return (
    <OnboardingProvider>
      <PageHeaderProvider>
        <div className="dashboard-theme flex h-dvh min-h-dvh w-full overflow-hidden bg-neutral-950">
          <Sidebar isOpen={sidebarOpen} onToggle={handleToggleSidebar} />

          <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2 md:gap-3 md:p-3 md:pl-0">
            <Header
              onToggleSidebar={handleToggleSidebar}
              isAnonymous={headerAnonymous}
              authGraceActive={headerAuthGraceActive}
            />

            <ScrollArea className="min-w-0 flex-1 border border-white/10 bg-black/80">
              <main className="min-w-0 p-3 md:p-6">
                <Suspense fallback={<DashboardLoadingState />}>
                  <Outlet />
                </Suspense>
              </main>
            </ScrollArea>
          </div>
        </div>
      </PageHeaderProvider>
      <OnboardingOverlay />
    </OnboardingProvider>
  );
}
