import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import {
  generateOrganizationSchema,
  generateWebApplicationSchema,
} from "@/lib/seo";

interface OldLandingProps {
  searchParams: Promise<{ session_id?: string; from?: string; error?: string }>;
}

/**
 * Old Landing Page (archived)
 *
 * This is the previous landing page design, kept at /oldlanding for reference.
 */
export default async function OldLanding({ searchParams }: OldLandingProps) {
  const params = await searchParams;

  // If session_id is present, redirect to billing success page
  if (params.session_id) {
    const from = params.from || "settings";
    redirect(
      `/dashboard/billing/success?session_id=${params.session_id}&from=${from}`,
    );
  }

  const organizationSchema = generateOrganizationSchema();
  const webAppSchema = generateWebApplicationSchema();

  const accessError = params.error || undefined;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }}
      />
      <LandingPage accessError={accessError} />
    </>
  );
}
