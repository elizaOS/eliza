/**
 * /dashboard/apps — the Applications list (cloud OAuth apps). Under the app
 * shell the document head is owned by the host, not per-cloud-route. Auth
 * gating uses `useSessionAuth()` (Steward session).
 */

import { Activity, Grid3x3, TrendingUp, Users } from "lucide-react";
import { DashboardStatCard } from "../../cloud-ui/components/brand";
import {
  AppsEmptyState,
  AppsPageWrapper,
  AppsSkeleton,
} from "../../cloud-ui/components/dashboard/cloud-dashboard-components";
import { DashboardErrorState } from "../../cloud-ui/components/dashboard/route-placeholders";
import {
  DashboardPageContainer,
  DashboardStatGrid,
} from "../../cloud-ui/components/layout";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AppsTable } from "./components/apps-table";
import { useApps } from "./lib/apps";

/** /dashboard/apps */
export default function ApplicationsPage() {
  const t = useCloudT();
  const session = useSessionAuth();
  const { data, isLoading, isError, error } = useApps();

  const apps = data ?? [];
  const totalUsers = apps.reduce((sum, app) => sum + app.total_users, 0);
  const totalRequests = apps.reduce((sum, app) => sum + app.total_requests, 0);
  const activeCount = apps.filter((a) => a.is_active).length;

  return (
    <AppsPageWrapper>
      <DashboardPageContainer className="space-y-4 md:space-y-6">
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
            icon={<Users className="h-5 w-5 text-muted" />}
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
          // Apps are created BY the agent (chat: "build me an app…"), never
          // from the console — the dashboard only manages what exists.
          <AppsEmptyState
            description={t("cloud.apps.emptyAgentHint", {
              defaultValue:
                "Ask your Eliza agent to build and deploy an app — it will show up here to manage, monetize, and share.",
            })}
          />
        ) : (
          <AppsTable apps={apps} />
        )}
      </DashboardPageContainer>
    </AppsPageWrapper>
  );
}
