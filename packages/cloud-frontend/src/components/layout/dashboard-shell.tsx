import {
  DashboardLoadingState,
  DashboardShellLayout,
  PageHeaderProvider,
  TooltipProvider,
} from "@elizaos/ui";
import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";
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
  const t = useT();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  if (!authReady) {
    return (
      <div className="flex min-h-dvh w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            {t("cloud.dashboardShell.loading", { defaultValue: "Loading..." })}
          </p>
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
          <DashboardShellLayout
            sidebar={
              <Sidebar isOpen={sidebarOpen} onToggle={handleToggleSidebar} />
            }
            header={
              <Header
                onToggleSidebar={handleToggleSidebar}
                isAnonymous={headerAnonymous}
                authGraceActive={headerAuthGraceActive}
              />
            }
          >
            <Suspense fallback={<DashboardLoadingState />}>
              <Outlet />
            </Suspense>
          </DashboardShellLayout>
        </PageHeaderProvider>
      </TooltipProvider>
      <OnboardingOverlay />
    </OnboardingProvider>
  );
}
