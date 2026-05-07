import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { generateOrganizationSchema, generateWebApplicationSchema } from "@/lib/seo";
import { LandingPage } from "@elizaos/cloud-ui/components/landing/landing-page-new";

/**
 * Landing Page.
 *
 * Authentication is handled client-side via Steward (`useSessionAuth`).
 * The LandingPage component checks auth state and redirects to /dashboard
 * when the user is authenticated.
 *
 * If `session_id` is present in the URL, redirect to the billing success
 * page (handles cases where Stripe redirects to the wrong URL).
 */
export default function Home() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = searchParams.get("session_id");
  const from = searchParams.get("from") || "settings";
  const accessError = searchParams.get("error") || undefined;

  useEffect(() => {
    if (sessionId) {
      navigate(`/dashboard/billing/success?session_id=${sessionId}&from=${from}`, {
        replace: true,
      });
    }
  }, [sessionId, from, navigate]);

  if (sessionId) {
    return (
      <Navigate to={`/dashboard/billing/success?session_id=${sessionId}&from=${from}`} replace />
    );
  }

  const organizationSchema = generateOrganizationSchema();
  const webAppSchema = generateWebApplicationSchema();

  return (
    <>
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(organizationSchema)}</script>
        <script type="application/ld+json">{JSON.stringify(webAppSchema)}</script>
      </Helmet>
      <LandingPage accessError={accessError} />
    </>
  );
}
