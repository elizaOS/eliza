import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";

export default function PaymentSuccessLayout() {
  return (
    <>
      <Helmet>
        <title>Payment Successful | Eliza Cloud</title>
        <meta
          name="description"
          content="Your payment was processed successfully. You will be redirected to your dashboard shortly."
        />
      </Helmet>
      <Outlet />
    </>
  );
}
