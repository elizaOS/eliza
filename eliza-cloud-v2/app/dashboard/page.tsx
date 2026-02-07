import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { generatePageMetadata, ROUTE_METADATA } from "@/lib/seo";
import { getDashboardData } from "@/lib/actions/dashboard";
import { DashboardPageWrapper } from "@/components/dashboard/dashboard-page-wrapper";
import {
  AgentsSection,
  AgentsSectionSkeleton,
} from "@/components/dashboard/agents-section";
import {
  ContainersSection,
  ContainersSectionSkeleton,
} from "@/components/dashboard/containers-section";
import {
  AppsSection,
  AppsSectionSkeleton,
} from "@/components/dashboard/apps-section";
import { SurveyBanner } from "@/components/dashboard/survey-banner";

export const metadata: Metadata = generatePageMetadata({
  ...ROUTE_METADATA.dashboard,
  path: "/dashboard",
  noIndex: true,
});

export const dynamic = "force-dynamic";

/**
 * Main dashboard page displaying user's agents and containers.
 *
 * @returns Dashboard page with agents and containers sections.
 */
export default async function DashboardPage() {
  let data;
  try {
    data = await getDashboardData();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Unauthorized") ||
        error.message.includes("Forbidden"))
    ) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <DashboardPageWrapper userName={data.user.name.split(" ")[0] || "User"}>
      <main className="mx-auto w-full max-w-[1400px]">
        <SurveyBanner className="mb-6" />
        <div className="space-y-8">
          <section>
            <Suspense fallback={<AppsSectionSkeleton />}>
              <AppsSection apps={data.apps ?? []} />
            </Suspense>
          </section>

          <section>
            <Suspense fallback={<AgentsSectionSkeleton />}>
              <AgentsSection agents={data.agents} />
            </Suspense>
          </section>

          <section>
            <Suspense fallback={<ContainersSectionSkeleton />}>
              <ContainersSection containers={data.containers} />
            </Suspense>
          </section>
        </div>
      </main>
    </DashboardPageWrapper>
  );
}
