import {
  ContainersEmptyState,
  ContainersPageWrapper,
  ContainersSkeleton,
  DashboardErrorState,
  DashboardPageContainer,
  DashboardStatCard,
  DashboardStatGrid,
} from "@elizaos/ui";
import { Activity, AlertCircle, Server, TrendingUp } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useContainers } from "../../lib/data/containers";
import { ContainersTable } from "./_components/containers-table";
import { DeployFromCLI } from "./_components/deploy-from-cli";

/** /dashboard/containers — list of containers deployed by the caller's organization. */
export default function ContainersPage() {
  const t = useT();
  const session = useRequireAuth();
  const { data, isLoading, error } = useContainers();

  const containers = data ?? [];
  const stats = {
    total: containers.length,
    running: containers.filter((c) => c.status === "running").length,
    building: containers.filter(
      (c) =>
        c.status === "building" ||
        c.status === "deploying" ||
        c.status === "pending",
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
        <title>
          {t("cloud.containers.metaTitle", { defaultValue: "Containers" })}
        </title>
        <meta
          name="description"
          content={t("cloud.containers.metaDescription", {
            defaultValue:
              "Deploy and manage elizaOS containers. Monitor health, view logs, and scale your AI agent deployments with our cloud infrastructure.",
          })}
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
                  label={t("cloud.containers.stat.total", {
                    defaultValue: "Total Containers",
                  })}
                  value={stats.total}
                  accent="orange"
                  icon={<Server className="h-5 w-5 text-[#FF5800]" />}
                />
                <DashboardStatCard
                  label={t("cloud.containers.stat.running", {
                    defaultValue: "Running",
                  })}
                  value={stats.running}
                  accent="emerald"
                  icon={<Activity className="h-5 w-5 text-green-400" />}
                />
                <DashboardStatCard
                  label={t("cloud.containers.stat.building", {
                    defaultValue: "Building",
                  })}
                  value={stats.building}
                  accent="amber"
                  icon={<TrendingUp className="h-5 w-5 text-orange-400" />}
                />
                <DashboardStatCard
                  label={t("cloud.containers.stat.issues", {
                    defaultValue: "Issues",
                  })}
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
