import { Suspense } from "react";
import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { listContainers } from "@/lib/services/containers";
import { ContainersTable } from "@/components/containers/containers-table";
import { ContainersSkeleton } from "@/components/containers/containers-skeleton";
import { Server, Activity, TrendingUp, AlertCircle } from "lucide-react";
import { ContainersPageWrapper } from "./containers-page-wrapper";
import { ContainersEmptyState } from "./containers-empty-state";
import { DeployFromCLI } from "./deploy-from-cli";

export const metadata: Metadata = {
  title: "Containers",
  description:
    "Deploy and manage ElizaOS containers. Monitor health, view logs, and scale your AI agent deployments with our cloud infrastructure.",
};

export const dynamic = "force-dynamic";

/**
 * Containers page displaying all containers deployed by the authenticated user's organization.
 * Shows statistics (total, running, building, failed) and a table of containers.
 */
export default async function ContainersPage() {
  const user = await requireAuthWithOrg();
  const containers = await listContainers(user.organization_id);

  const stats = {
    total: containers.length,
    running: containers.filter((c) => c.status === "running").length,
    stopped: containers.filter((c) => c.status === "stopped").length,
    failed: containers.filter((c) => c.status === "failed").length,
    building: containers.filter(
      (c) =>
        c.status === "building" ||
        c.status === "deploying" ||
        c.status === "pending",
    ).length,
  };

  return (
    <ContainersPageWrapper>
      <div className="mx-auto w-full max-w-[1400px] space-y-6">
        {/* Stats Grid - only show when containers exist */}
        {containers.length > 0 && (
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Containers"
              value={stats.total}
              icon={<Server className="h-5 w-5 text-[#FF5800]" />}
            />
            <StatCard
              label="Running"
              value={stats.running}
              icon={<Activity className="h-5 w-5 text-green-500" />}
            />
            <StatCard
              label="Building"
              value={stats.building}
              icon={<TrendingUp className="h-5 w-5 text-yellow-500" />}
            />
            <StatCard
              label="Issues"
              value={stats.failed}
              icon={<AlertCircle className="h-5 w-5 text-red-500" />}
            />
          </div>
        )}

        {/* Containers Table or Empty State */}
        {containers.length === 0 ? (
          <ContainersEmptyState />
        ) : (
          <>
            {/* Deploy from CLI helper */}
            <DeployFromCLI />

            {/* Table */}
            <div className="bg-neutral-900 rounded-xl p-4 md:p-6">
              <Suspense fallback={<ContainersSkeleton />}>
                <ContainersTable containers={containers} />
              </Suspense>
            </div>
          </>
        )}
      </div>
    </ContainersPageWrapper>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-neutral-900 rounded-xl p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-neutral-500">{label}</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-1">
            {value}
          </p>
        </div>
        {icon}
      </div>
    </div>
  );
}
