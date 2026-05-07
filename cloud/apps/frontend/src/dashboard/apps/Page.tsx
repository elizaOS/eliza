import {
  DashboardErrorState,
  DashboardPageContainer,
  DashboardStatCard,
  DashboardStatGrid,
  DashboardToolbar,
} from "@elizaos/cloud-ui";
import { Activity, ChevronDown, Grid3x3, TrendingUp, Users } from "lucide-react";
import { Helmet } from "react-helmet-async";
import type { AppDto } from "@/types/cloud-api";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useApps } from "../../lib/data/apps";
import { AppsEmptyState } from "./_components/apps-empty-state";
import { AppsPageWrapper } from "./_components/apps-page-wrapper";
import { AppsSkeleton } from "./_components/apps-skeleton";
import { AppsTable } from "./_components/apps-table";
import { CreateAppButton } from "./_components/create-app-button";

function AdvancedRegisterApp() {
  return (
    <details className="group inline-block w-full sm:w-auto">
      <summary className="inline-flex w-full cursor-pointer list-none items-center justify-center gap-1 text-sm font-mono text-white/60 transition-colors hover:text-white sm:w-auto">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        Advanced
      </summary>
      <div className="mt-2 flex justify-stretch sm:justify-end">
        <CreateAppButton />
      </div>
    </details>
  );
}

/** /dashboard/apps */
export default function AppsPage() {
  const session = useRequireAuth();
  const { data, isLoading, isError, error } = useApps();

  const apps = data ?? [];
  const totalUsers = apps.reduce((sum, app) => sum + (app.total_users ?? 0), 0);
  const totalRequests = apps.reduce((sum, app) => sum + (app.total_requests ?? 0), 0);
  const activeCount = apps.filter((a) => a.is_active).length;

  return (
    <>
      <Helmet>
        <title>Apps</title>
        <meta
          name="description"
          content="Manage apps your agents created. Toggle monetization, view earnings, deploy as containers."
        />
      </Helmet>
      <AppsPageWrapper>
        <DashboardPageContainer className="space-y-4 md:space-y-6">
          <DashboardToolbar className="justify-end">
            <AdvancedRegisterApp />
          </DashboardToolbar>
          <DashboardStatGrid data-onboarding="apps-stats">
            <DashboardStatCard
              label="Total Apps"
              value={apps.length}
              icon={<Grid3x3 className="h-5 w-5 text-[#FF5800]" />}
            />
            <DashboardStatCard
              label="Active Apps"
              value={activeCount}
              icon={<Activity className="h-5 w-5 text-green-500" />}
            />
            <DashboardStatCard
              label="Total Users"
              value={totalUsers.toLocaleString()}
              icon={<Users className="h-5 w-5 text-blue-500" />}
            />
            <DashboardStatCard
              label="Total Requests"
              value={totalRequests.toLocaleString()}
              icon={<TrendingUp className="h-5 w-5 text-purple-500" />}
            />
          </DashboardStatGrid>
          {!session.ready || isLoading ? (
            <AppsSkeleton />
          ) : isError ? (
            <DashboardErrorState
              message={error instanceof Error ? error.message : "Failed to load apps"}
            />
          ) : apps.length === 0 ? (
            <AppsEmptyState
              description="Your agent will create apps here when you have it build something."
              action={<AdvancedRegisterApp />}
            />
          ) : (
            <AppsTable apps={apps as unknown as AppDto[]} />
          )}
        </DashboardPageContainer>
      </AppsPageWrapper>
    </>
  );
}
