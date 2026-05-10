import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";

export default function AppChargePaymentLayout() {
  return (
    <>
      <Helmet>
        <title>Pay App Charge | Eliza Cloud</title>
        <meta name="description" content="Pay an app charge with a card or cryptocurrency." />
      </Helmet>
      <Outlet />
    </>
  );
}
