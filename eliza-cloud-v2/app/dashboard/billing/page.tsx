import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth";
import { creditsService } from "@/lib/services/credits";
import { BillingPageWrapper } from "@/components/billing/billing-page-wrapper";

export const metadata: Metadata = {
  title: "Billing",
  description: "Add funds and manage your billing",
};

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

/**
 * Billing page for managing credits and billing information.
 * Displays available credit packs and current credit balance.
 *
 * @param searchParams - Search parameters, including optional `canceled` flag for canceled checkout sessions.
 * @returns The rendered billing page wrapper component.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ canceled?: string }>;
}) {
  const user = await requireAuth();
  const creditPacks = await creditsService.listActiveCreditPacks();
  const params = await searchParams;

  return (
    <BillingPageWrapper
      creditPacks={creditPacks}
      currentCredits={Number(user.organization?.credit_balance)}
      canceled={params.canceled}
    />
  );
}
