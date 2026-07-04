/**
 * /dashboard/apps — the Applications list (cloud OAuth apps). Under the app
 * shell the document head is owned by the host, not per-cloud-route. Auth
 * gating uses `useRequireAuth()` (Steward session).
 */

import { Activity, Grid3x3, TrendingUp, Users } from "lucide-react";
import { BrandCard, DashboardStatCard } from "../../cloud-ui/components/brand";
import {
  AppsEmptyState,
  AppsPageWrapper,
  AppsSkeleton,
} from "../../cloud-ui/components/dashboard/cloud-dashboard-components";
import { DashboardErrorState } from "../../cloud-ui/components/dashboard/route-placeholders";
import {
  DashboardPageContainer,
  DashboardStatGrid,
  DashboardToolbar,
} from "../../cloud-ui/components/layout";
import { Skeleton } from "../../components/ui/skeleton";
import { useRequireAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AppsTable } from "./components/apps-table";
import { CreateAppButton } from "./components/create-app-button";
import { useApps } from "./lib/apps";

function AppsStatsSkeleton(): React.JSX.Element {
  return (
    <DashboardStatGrid data-onboarding="apps-stats">
      {["total", "active", "users", "requests"].map((id) => (
        <BrandCard
          key={id}
          className="min-h-[108px] justify-between p-4"
          corners={false}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-3 w-24 bg-white/10" />
              <Skeleton className="h-7 w-16 bg-white/10" />
            </div>
            <Skeleton className="size-10 rounded-sm bg-white/10" />
          </div>
          <Skeleton className="h-3 w-28 bg-white/10" />
        </BrandCard>
      ))}
    </DashboardStatGrid>
  );
}

/** /dashboard/apps */
export default function ApplicationsPage() {
  const t = useCloudT();
  const session = useRequireAuth();
  const { data, isLoading, isError, error } = useApps();

  const apps = data ?? [];
  const totalUsers = apps.reduce((sum, app) => sum + app.total_users, 0);
  const totalRequests = apps.reduce((sum, app) => sum + app.total_requests, 0);
  const activeCount = apps.filter((a) => a.is_active).length;
  const showLoading = !session.ready || isLoading;

  return (
    <AppsPageWrapper>
      <DashboardPageContainer className="space-y-4 md:space-y-6">
        <DashboardToolbar className="justify-end">
          <CreateAppButton />
        </DashboardToolbar>
        {showLoading ? (
          <AppsStatsSkeleton />
        ) : isError ? null : (
          <DashboardStatGrid data-onboarding="apps-stats">
            <DashboardStatCard
              label={t("cloud.apps.stat.totalApps", {
                defaultValue: "Total Apps",
              })}
              value={apps.length}
              icon={<Grid3x3 className="h-5 w-5 text-[var(--accent)]" />}
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
              icon={<Users className="h-5 w-5 text-white/70" />}
            />
            <DashboardStatCard
              label={t("cloud.apps.stat.totalRequests", {
                defaultValue: "Total Requests",
              })}
              value={totalRequests.toLocaleString()}
              icon={<TrendingUp className="h-5 w-5 text-purple-500" />}
            />
          </DashboardStatGrid>
        )}
        {showLoading ? (
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
          <AppsEmptyState action={<CreateAppButton />} />
        ) : (
          <AppsTable apps={apps} />
        )}
      </DashboardPageContainer>
    </AppsPageWrapper>
  );
}
