import type { Metadata } from "next";
import {
  getEnhancedAnalyticsData,
  getProjectionsData,
} from "@/lib/actions/analytics-enhanced";
import { requireAuth } from "@/lib/auth";
import { AnalyticsPageClient } from "@/components/analytics/analytics-page-client";

// Force dynamic rendering for authenticated pages
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Analytics",
  description:
    "View detailed usage statistics, performance metrics, and insights for your AI agents",
  keywords: ["analytics", "statistics", "metrics", "insights", "performance"],
};

interface AnalyticsPageProps {
  searchParams: Promise<{
    startDate?: string;
    endDate?: string;
    granularity?: "hour" | "day" | "week" | "month";
    timeRange?: "daily" | "weekly" | "monthly";
  }>;
}

/**
 * Analytics page displaying detailed usage statistics, performance metrics, and insights.
 * Supports filtering by date range, granularity, and time range.
 *
 * @param props - Page props containing search parameters for filtering analytics data.
 * @returns The rendered analytics page client component with data and projections.
 */
export default async function AnalyticsPage(props: AnalyticsPageProps) {
  await requireAuth();

  const searchParams = await props.searchParams;

  const filters = {
    startDate: searchParams.startDate
      ? new Date(searchParams.startDate)
      : undefined,
    endDate: searchParams.endDate ? new Date(searchParams.endDate) : undefined,
    granularity: searchParams.granularity || ("day" as const),
    timeRange: searchParams.timeRange || ("weekly" as const),
  };

  const [data, projectionsData] = await Promise.all([
    getEnhancedAnalyticsData(filters),
    getProjectionsData(7),
  ]);

  return <AnalyticsPageClient data={data} projectionsData={projectionsData} />;
}
