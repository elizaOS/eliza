/**
 * Third-party app OAuth-authorize page (public). Reuses the cloud-ui
 * `AuthorizeContent` component (the shared authorize UI).
 *
 * `AuthorizeContent` calls `useAuth()` / renders `<StewardLogin>` from
 * `@stwd/react`, both of which require an ancestor Steward `<StewardProvider>`.
 * As a `public: true` route this page renders WITHOUT the per-route Steward
 * wrapper (see `CloudRouteElement`), so it must mount the shell's
 * `StewardAuthProvider` itself — otherwise `useAuth()` throws "must be used
 * within a <StewardProvider>" and all monetized-app sign-in is blocked (#9881).
 * `StewardAuthProvider` already lists `/app-auth` in its runtime route patterns,
 * so it mounts the Steward runtime even for an unauthenticated visitor.
 */

import { Suspense } from "react";
import { AuthorizeContent } from "../../../../cloud-ui/components/auth/authorize-content";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { StewardAuthProvider } from "../../../shell/StewardProvider";
import { usePageTitle } from "../../lib/use-page-title";

export default function AppAuthAuthorizePage() {
  const t = useCloudT();
  usePageTitle(
    t("cloud.appAuth.metaTitle", {
      defaultValue: "Authorize App | Eliza Cloud",
    }),
  );
  return (
    <StewardAuthProvider>
      <Suspense fallback={null}>
        <AuthorizeContent />
      </Suspense>
    </StewardAuthProvider>
  );
}
