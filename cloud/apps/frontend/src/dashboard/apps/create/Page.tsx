import { Helmet } from "react-helmet-async";
import { Navigate } from "react-router-dom";

/**
 * /dashboard/apps/create
 *
 * The legacy app builder this page used to render is currently
 * disabled. App creation happens via CreateAppDialog (manual) or the
 * cloud SDK (agent path), so this route redirects back to the apps list.
 */
export default function AppBuilderPage() {
  return (
    <>
      <Helmet>
        <title>App Builder</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <Navigate to="/dashboard/apps" replace />
    </>
  );
}
