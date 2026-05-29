import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function AppChargePaymentLayout() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.appChargePayment.pageTitle", {
            defaultValue: "Pay App Charge | Eliza Cloud",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.appChargePayment.metaDescription", {
            defaultValue: "Pay an app charge with a card or cryptocurrency.",
          })}
        />
      </Helmet>
      <Outlet />
    </>
  );
}
