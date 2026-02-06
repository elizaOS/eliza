import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payment Successful",
  description:
    "Your payment was processed successfully. You will be redirected to your dashboard shortly.",
};

export default function PaymentSuccessLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
