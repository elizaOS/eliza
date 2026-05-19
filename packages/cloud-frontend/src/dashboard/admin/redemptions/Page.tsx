import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { AdminRedemptionsWrapper } from "../_components/redemptions-wrapper";

/** /dashboard/admin/redemptions — review and approve token redemption requests. */
export default function AdminRedemptionsPage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.admin.redemptionsPage.metaTitle", {
            defaultValue: "Admin: Redemption Management",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.admin.redemptionsPage.metaDescription", {
            defaultValue: "Review and approve token redemption requests",
          })}
        />
      </Helmet>
      <AdminRedemptionsWrapper />
    </>
  );
}
