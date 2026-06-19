import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function LoginLayout() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.login.pageTitle", { defaultValue: "Login | Eliza Cloud" })}
        </title>
        <meta
          name="description"
          content={t("cloud.login.metaDescription", {
            defaultValue: "Sign in to run your Eliza in Cloud.",
          })}
        />
        <meta name="robots" content="noindex" />
      </Helmet>
      <Outlet />
    </>
  );
}
