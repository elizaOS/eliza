import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

export default function PaymentSuccessLayout() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.paymentSuccess.pageTitle", {
            defaultValue: "Payment Successful | Eliza Cloud",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.paymentSuccess.metaDescription", {
            defaultValue:
              "Your payment was processed successfully. You will be redirected to your dashboard shortly.",
          })}
        />
      </Helmet>
      <Outlet />
    </>
  );
}
