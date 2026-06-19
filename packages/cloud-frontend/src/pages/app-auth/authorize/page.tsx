import { AuthorizeContent } from "@elizaos/ui";
import { Suspense } from "react";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";

export default function AppAuthAuthorizePage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.appAuth.metaTitle", {
            defaultValue: "Authorize App | Eliza Cloud",
          })}
        </title>
      </Helmet>
      <Suspense fallback={null}>
        <AuthorizeContent />
      </Suspense>
    </>
  );
}
