import {
  AppsEmptyState,
  AppsPageWrapper,
  AppsSkeleton,
  DashboardErrorState,
  DashboardPageContainer,
  DashboardStatCard,
  DashboardStatGrid,
  DashboardToolbar,
} from "@elizaos/ui";
import {
  Activity,
  ChevronDown,
  Grid3x3,
  TrendingUp,
  Users,
} from "lucide-react";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useApps } from "../../lib/data/apps";
import { AppsTable } from "./_components/apps-table";
import { CreateAppButton } from "./_components/create-app-button";

function AdvancedRegisterApp() {
  const t = useT();
  return (
    <details className="group inline-block w-full sm:w-auto">
      <summary className="inline-flex w-full cursor-pointer list-none items-center justify-center gap-1 text-sm font-mono text-white/60 transition-colors hover:text-white sm:w-auto">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        {t("cloud.apps.advanced", { defaultValue: "Advanced" })}
      </summary>
      <div className="mt-2 flex justify-stretch sm:justify-end">
        <CreateAppButton />
      </div>
    </details>
  );
}

/** /dashboard/apps */
export default function AppsPage() {
  const t = useT();
  const session = useRequireAuth();
  const { data, isLoading, isError, error } = useApps();

  const apps = data ?? [];
  const totalUsers = apps.reduce((sum, app) => sum + app.total_users, 0);
  const totalRequests = apps.reduce((sum, app) => sum + app.total_requests, 0);
  const activeCount = apps.filter((a) => a.is_active).length;

  return (
    <>
      <Helmet>
        <title>{t("cloud.apps.metaTitle", { defaultValue: "Apps" })}</title>
        <meta
          name="description"
          content={t("cloud.apps.metaDescription", {
            defaultValue:
              "Manage apps your agents created. Toggle monetization, view earnings, deploy as containers.",
          })}
        />
      </Helmet>
      <AppsPageWrapper>
        <DashboardPageContainer className="space-y-4 md:space-y-6">
          <DashboardToolbar className="justify-end">
            <AdvancedRegisterApp />
          </DashboardToolbar>
          <DashboardStatGrid data-onboarding="apps-stats">
            <DashboardStatCard
              label={t("cloud.apps.stat.totalApps", {
                defaultValue: "Total Apps",
              })}
              value={apps.length}
              icon={<Grid3x3 className="h-5 w-5 text-[#FF5800]" />}
            />
            <DashboardStatCard
              label={t("cloud.apps.stat.activeApps", {
                defaultValue: "Active Apps",
              })}
              value={activeCount}
              icon={<Activity className="h-5 w-5 text-green-500" />}
            />
            <DashboardStatCard
              label={t("cloud.apps.stat.totalUsers", {
                defaultValue: "Total Users",
              })}
              value={totalUsers.toLocaleString()}
              icon={<Users className="h-5 w-5 text-blue-500" />}
            />
            <DashboardStatCard
              label={t("cloud.apps.stat.totalRequests", {
                defaultValue: "Total Requests",
              })}
              value={totalRequests.toLocaleString()}
              icon={<TrendingUp className="h-5 w-5 text-purple-500" />}
            />
          </DashboardStatGrid>
          {!session.ready || isLoading ? (
            <AppsSkeleton />
          ) : isError ? (
            <DashboardErrorState
              message={
                error instanceof Error
                  ? error.message
                  : t("cloud.apps.error.load", {
                      defaultValue: "Failed to load apps",
                    })
              }
            />
          ) : apps.length === 0 ? (
            <AppsEmptyState action={<AdvancedRegisterApp />} />
          ) : (
            <AppsTable apps={apps} />
          )}
        </DashboardPageContainer>
      </AppsPageWrapper>
    </>
  );
}
