import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth";
import { EarningsPageWrapper } from "@/components/earnings/earnings-page-wrapper";

export const metadata: Metadata = {
  title: "Earnings & Redemptions",
  description: "View your earnings and redeem for elizaOS tokens",
};

export const dynamic = "force-dynamic";

export default async function EarningsPage() {
  await requireAuth();
  return <EarningsPageWrapper />;
}
