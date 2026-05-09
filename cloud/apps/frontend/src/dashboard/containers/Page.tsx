import {
  DashboardErrorState,
  DashboardPageContainer,
  DashboardStatCard,
  DashboardStatGrid,
} from "@elizaos/cloud-ui";
import { Activity, AlertCircle, Server, TrendingUp } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useContainers } from "../../lib/data/containers";
import { ContainersEmptyState } from "./_components/containers-empty-state";
import { ContainersPageWrapper } from "./_components/containers-page-wrapper";
import { ContainersSkeleton } from "./_components/containers-skeleton";
import { ContainersTable } from "./_components/containers-table";
import { DeployFromCLI } from "./_components/deploy-from-cli";

/** /dashboard/containers — list of containers deployed by the caller's organization. */
export default function ContainersPage() {
  const session = useRequireAuth();
  const { data, isLoading, error } = useContainers();

  const containers = data ?? [];
  const stats = {
    total: containers.length,
    running: containers.filter((c) => c.status === "running").length,
    building: containers.filter(
      (c) => c.status === "building" || c.status === "deploying" || c.status === "pending",
    ).length,
    failed: containers.filter((c) => c.status === "failed").length,
  };

  const tableContainers = containers.map((c) => ({
    ...c,
    last_deployed_at: c.last_deployed_at ? new Date(c.last_deployed_at) : null,
    created_at: new Date(c.created_at),
  }));

  return (
    <>
      <Helmet>
        <title>Containers</title>
        <meta
          name="description"
          content="Deploy and manage elizaOS containers. Monitor health, view logs, and scale your AI agent deployments with our cloud infrastructure."
        />
      </Helmet>
      <ContainersPageWrapper>
        <DashboardPageContainer className="space-y-6 md:space-y-8">
          {!session.ready || (session.authenticated && isLoading) ? (
            <ContainersSkeleton />
          ) : error ? (
            <DashboardErrorState message={error.message} />
          ) : containers.length === 0 ? (
            <ContainersEmptyState />
          ) : (
            <>
              <DashboardStatGrid>
                <DashboardStatCard
                  label="Total Containers"
                  value={stats.total}
                  accent="orange"
                  icon={<Server className="h-5 w-5 text-[#FF5800]" />}
                />
                <DashboardStatCard
                  label="Running"
                  value={stats.running}
                  accent="emerald"
                  icon={<Activity className="h-5 w-5 text-emerald-400" />}
                />
                <DashboardStatCard
                  label="Building"
                  value={stats.building}
                  accent="amber"
                  icon={<TrendingUp className="h-5 w-5 text-amber-400" />}
                />
                <DashboardStatCard
                  label="Issues"
                  value={stats.failed}
                  accent="red"
                  icon={<AlertCircle className="h-5 w-5 text-red-400" />}
                />
              </DashboardStatGrid>
              <div className="space-y-4">
                <DeployFromCLI />
                <ContainersTable containers={tableContainers} />
              </div>
            </>
          )}
        </DashboardPageContainer>
      </ContainersPageWrapper>
    </>
  );
}
