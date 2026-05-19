import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { MyAgentsClient } from "../../components/my-agents/my-agents";
import { useRequireAuth } from "../../lib/auth-hooks";

/** /dashboard/my-agents */
export default function MyAgentsPage() {
  const t = useT();
  const session = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.myAgents.metaTitle", { defaultValue: "My Agent" })}
        </title>
        <meta
          name="description"
          content={t("cloud.myAgents.metaDescription", {
            defaultValue: "Administer your running Eliza Cloud agent.",
          })}
        />
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      {!session.ready ? (
        <DashboardLoadingState
          label={t("cloud.myAgents.loading", {
            defaultValue: "Loading agents",
          })}
        />
      ) : (
        <MyAgentsClient />
      )}
    </>
  );
}
