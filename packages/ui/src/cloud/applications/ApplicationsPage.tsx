/**
 * /cloud/apps — the Applications list (cloud OAuth apps). Under the app
 * shell the document head is owned by the host, not per-cloud-route. Auth
 * gating uses `useSessionAuth()` (Steward session).
 */

import { useQueryClient } from "@tanstack/react-query";
import { Activity, Grid3x3, TrendingUp, Users } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { DashboardStatCard } from "../../cloud-ui/components/brand/dashboard-stat-card";
import {
  AppsEmptyState,
  AppsPageWrapper,
  AppsSkeleton,
} from "../../cloud-ui/components/dashboard/cloud-dashboard-components";
import { DashboardErrorState } from "../../cloud-ui/components/dashboard/route-placeholders";
import {
  DashboardPageContainer,
  DashboardStatGrid,
} from "../../cloud-ui/components/layout/dashboard-page";
import { authenticatedQueryKey } from "../lib/auth-query";
import { useSessionAuth } from "../lib/use-session-auth";
import { useOrganizationUser } from "../organization/data/use-organization";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AppsTable } from "./components/apps-table";
import { APPS_QUERY_KEY, useApps } from "./lib/apps";

/** /cloud/apps */
export default function ApplicationsPage() {
  const t = useCloudT();
  const session = useSessionAuth();
  const organization = useOrganizationUser();
  const queryClient = useQueryClient();
  const userId = session.user?.id ?? null;
  const organizationId = organization.data?.organization_id ?? null;
  const authorityUserId = organization.data?.id;
  const queryKey = useMemo(
    () => authenticatedQueryKey(APPS_QUERY_KEY, { enabled: true, userId }),
    [userId],
  );
  const lastRequestedScope = useRef<string | null>(null);
  const observedScope = JSON.stringify([
    userId,
    authorityUserId,
    organizationId,
  ]);
  useEffect(() => {
    if (!authorityUserId) {
      lastRequestedScope.current = null;
      return;
    }
    if (lastRequestedScope.current === observedScope) return;
    lastRequestedScope.current = observedScope;
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey, authorityUserId, observedScope]);
  const { data, isLoading, isError, error } = useApps();

  const apps = data ?? [];
  const totalUsers = apps.reduce((sum, app) => sum + app.total_users, 0);
  const totalRequests = apps.reduce((sum, app) => sum + app.total_requests, 0);
  const activeCount = apps.filter((a) => a.is_active).length;

  return (
    <AppsPageWrapper>
      <DashboardPageContainer className="space-y-4 md:space-y-6">
        {!session.ready ? (
          <AppsSkeleton />
        ) : !session.authenticated ? (
          <DashboardErrorState
            message={t("cloud.apps.signInRequired", {
              defaultValue: "Sign in to Eliza Cloud to manage Cloud Apps.",
            })}
          />
        ) : organization.isLoading ? (
          <AppsSkeleton />
        ) : organization.isError || !organization.data ? (
          <DashboardErrorState
            message={
              organization.error instanceof Error
                ? organization.error.message
                : t("cloud.apps.error.load", {
                    defaultValue: "Failed to load apps",
                  })
            }
          />
        ) : apps.some((app) => app.organization_id !== organizationId) ? (
          <DashboardErrorState
            message={t("cloud.apps.error.load", {
              defaultValue: "Failed to load apps",
            })}
          />
        ) : (
          <>
            <DashboardStatGrid data-onboarding="apps-stats">
              <DashboardStatCard
                label={t("cloud.apps.stat.totalApps", {
                  defaultValue: "Total Apps",
                })}
                value={apps.length}
                icon={<Grid3x3 className="size-5 text-muted" />}
              />
              <DashboardStatCard
                label={t("cloud.apps.stat.activeApps", {
                  defaultValue: "Active Apps",
                })}
                value={activeCount}
                icon={<Activity className="size-5 text-status-success" />}
              />
              <DashboardStatCard
                label={t("cloud.apps.stat.totalUsers", {
                  defaultValue: "Total Users",
                })}
                value={totalUsers.toLocaleString()}
                icon={<Users className="size-5 text-muted" />}
              />
              <DashboardStatCard
                label={t("cloud.apps.stat.totalRequests", {
                  defaultValue: "Total Requests",
                })}
                value={totalRequests.toLocaleString()}
                icon={<TrendingUp className="size-5 text-accent" />}
              />
            </DashboardStatGrid>
            <AppsTable
              key={`${userId}:${organizationId}`}
              apps={apps}
              queryKey={queryKey}
            >
              {isLoading ? (
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
              ) : undefined}
            </AppsTable>
          </>
        )}
      </DashboardPageContainer>
    </AppsPageWrapper>
  );
}
