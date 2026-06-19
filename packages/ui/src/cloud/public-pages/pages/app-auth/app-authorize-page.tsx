/**
 * Third-party app OAuth-authorize page (public). Reuses the cloud-ui
 * `AuthorizeContent` component (the shared authorize UI). Ported from
 * `@elizaos/cloud-frontend/src/pages/app-auth/authorize/page.tsx`.
 */

import { Suspense } from "react";
import { AuthorizeContent } from "../../../../cloud-ui/components/auth/authorize-content";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

export default function AppAuthAuthorizePage() {
  const t = useCloudT();
  usePageTitle(
    t("cloud.appAuth.metaTitle", {
      defaultValue: "Authorize App | Eliza Cloud",
    }),
  );
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
