import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page-new";
import {
  generateOrganizationSchema,
  generateWebApplicationSchema,
} from "@/lib/seo";

interface HomeProps {
  searchParams: Promise<{ session_id?: string; from?: string; error?: string }>;
}

/**
 * Landing Page
 *
 * Authentication is handled entirely client-side by Privy.
 * The LandingPage component uses usePrivy() hook to check auth state
 * and redirects to /dashboard if the user is authenticated.
 *
 * This approach allows the page to be statically rendered.
 *
 * IMPORTANT: If session_id is present, redirect to billing success page
 * (handles case where Stripe redirects to wrong URL)
 */
export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  // If session_id is present, redirect to billing success page
  // This handles cases where Stripe might redirect to the wrong URL
  if (params.session_id) {
    const from = params.from || "settings";
    redirect(
      `/dashboard/billing/success?session_id=${params.session_id}&from=${from}`,
    );
  }

  const organizationSchema = generateOrganizationSchema();
  const webAppSchema = generateWebApplicationSchema();

  // Pass error parameter for displaying access denied messages
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
