import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function InviteAcceptLayout() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.inviteAccept.pageTitle", {
            defaultValue: "Accept Invitation | Eliza Cloud",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.inviteAccept.metaDescription", {
            defaultValue:
              "Accept your organization invitation to join an Eliza Cloud workspace and collaborate with your team.",
          })}
        />
      </Helmet>
      <Outlet />
    </>
  );
}
