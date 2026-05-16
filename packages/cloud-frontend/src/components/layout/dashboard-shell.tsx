import {
  CloudSkyBackground,
  DashboardLoadingState,
  PageHeaderProvider,
  ScrollArea,
  TooltipProvider,
} from "@elizaos/ui";
import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { OnboardingOverlay } from "../onboarding/onboarding-overlay";
import { OnboardingProvider } from "../onboarding/onboarding-provider";
import Header from "./header";
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
        <TooltipProvider>
          <PageHeaderProvider>
            <Suspense fallback={<DashboardLoadingState />}>
              <Outlet />
            </Suspense>
          </PageHeaderProvider>
        </TooltipProvider>
        <OnboardingOverlay />
      </OnboardingProvider>
    );
  }

  return (
    <OnboardingProvider>
      <TooltipProvider>
        <PageHeaderProvider>
          <CloudSkyBackground
            className="dashboard-theme h-dvh min-h-dvh w-full"
            contentClassName="flex h-dvh min-h-dvh w-full overflow-hidden"
            intensity="soft"
          >
            <Sidebar isOpen={sidebarOpen} onToggle={handleToggleSidebar} />

            <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2 md:gap-3 md:p-3 md:pl-0">
              <Header
                onToggleSidebar={handleToggleSidebar}
                isAnonymous={headerAnonymous}
                authGraceActive={headerAuthGraceActive}
              />

              <ScrollArea className="min-w-0 flex-1 rounded-[22px] border border-white/32 bg-white/30 shadow-[0_18px_54px_rgba(3,28,58,0.16)] backdrop-blur-2xl">
                <main className="min-w-0 p-3 md:p-6">
                  <Suspense fallback={<DashboardLoadingState />}>
                    <Outlet />
                  </Suspense>
                </main>
              </ScrollArea>
            </div>
          </CloudSkyBackground>
        </PageHeaderProvider>
      </TooltipProvider>
      <OnboardingOverlay />
    </OnboardingProvider>
  );
}
