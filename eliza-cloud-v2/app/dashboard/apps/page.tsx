import { Suspense } from "react";
import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { AppsTable } from "@/components/apps/apps-table";
import { AppsSkeleton } from "@/components/apps/apps-skeleton";
import { Grid3x3, Users, TrendingUp, Activity } from "lucide-react";
import { AppsPageWrapper } from "./apps-page-wrapper";
import { AppsEmptyState } from "./apps-empty-state";

export const metadata: Metadata = {
  title: "Apps",
  description:
    "Create and manage apps that integrate with Eliza Cloud services. Build AI-powered applications with custom configurations and track usage.",
};

export const dynamic = "force-dynamic";

/**
 * Apps page displaying all apps for the authenticated user's organization.
 * Shows statistics (total apps, active apps, total users, total requests) and a table of apps.
 */
export default async function AppsPage() {
  const user = await requireAuthWithOrg();
  const apps = await appsService.listByOrganization(user.organization_id);

  // Calculate stats
  const stats = {
    total: apps.length,
    active: apps.filter((a) => a.is_active).length,
    inactive: apps.filter((a) => !a.is_active).length,
    totalUsers: apps.reduce((sum, app) => sum + app.total_users, 0),
    totalRequests: apps.reduce((sum, app) => sum + app.total_requests, 0),
  };

  return (
    <AppsPageWrapper>
      <div className="w-full max-w-[1400px] mx-auto space-y-3 md:space-y-6">
        {/* Stats Grid */}
        <div
          className="grid gap-3 grid-cols-2 lg:grid-cols-4 min-w-0"
          data-onboarding="apps-stats"
        >
          <StatCard
            label="Total Apps"
            value={stats.total}
            icon={<Grid3x3 className="h-5 w-5 text-[#FF5800]" />}
          />
          <StatCard
            label="Active Apps"
            value={stats.active}
            icon={<Activity className="h-5 w-5 text-green-500" />}
          />
          <StatCard
            label="Total Users"
            value={stats.totalUsers.toLocaleString()}
            icon={<Users className="h-5 w-5 text-blue-500" />}
          />
          <StatCard
            label="Total Requests"
            value={stats.totalRequests.toLocaleString()}
            icon={<TrendingUp className="h-5 w-5 text-purple-500" />}
          />
        </div>

        {/* Apps Table or Empty State */}
        {apps.length === 0 ? (
          <AppsEmptyState />
        ) : (
          <Suspense fallback={<AppsSkeleton />}>
            <AppsTable apps={apps} />
          </Suspense>
        )}
      </div>
    </AppsPageWrapper>
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
    <div className="bg-neutral-900 rounded-xl p-3 md:p-4 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-neutral-500 truncate">{label}</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-1 truncate">
            {value}
          </p>
        </div>
        <div className="flex-shrink-0">{icon}</div>
      </div>
    </div>
  );
}
