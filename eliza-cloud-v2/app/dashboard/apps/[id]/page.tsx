import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { redirect } from "next/navigation";
import { AppDetailsTabs } from "@/components/apps/app-details-tabs";
import { isValidUUID } from "@/lib/utils";
import { AppPageWrapper } from "./app-page-wrapper";

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Generates metadata for the app details page.
 */
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;

  if (!isValidUUID(id)) {
    return {
      title: "App Not Found",
      robots: { index: false, follow: false },
    };
  }

  const user = await requireAuthWithOrg();
  const app = await appsService.getById(id);

  if (!app || app.organization_id !== user.organization_id) {
    return {
      title: "App Not Found",
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `${app.name} | Eliza Cloud`,
    description:
      app.description || `Manage ${app.name} app settings and analytics`,
    robots: { index: false, follow: false },
  };
}

/**
 * App details page displaying information for a specific app.
 */
export default async function AppDetailsPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;

  // Validate UUID format before querying database
  if (!isValidUUID(id)) {
    redirect("/dashboard/apps");
  }

  const user = await requireAuthWithOrg();
  const search = await searchParams;

  const app = await appsService.getById(id);

  // Verify app exists and belongs to user's organization
  if (!app || app.organization_id !== user.organization_id) {
    redirect("/dashboard/apps");
  }

  // Check if we should show the API key (only after creation)
  const showApiKey = search.showApiKey as string | undefined;

  return (
    <AppPageWrapper appName={app.name}>
      <div className="w-full max-w-[1400px] mx-auto space-y-3 sm:space-y-6">
        <AppDetailsTabs app={app} showApiKey={showApiKey} />
      </div>
    </AppPageWrapper>
  );
}
