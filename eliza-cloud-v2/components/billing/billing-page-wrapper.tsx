/**
 * Billing page wrapper component setting page header and displaying payment cancellation alerts.
 * Wraps billing page client with page context and alert handling.
 *
 * @param props - Billing page wrapper configuration
 * @param props.creditPacks - Array of available credit packs
 * @param props.currentCredits - Current credit balance
 * @param props.canceled - Optional cancellation message from Stripe
 */

"use client";

import { useSetPageHeader } from "@/components/layout/page-header-context";
import { BillingPageClient } from "./billing-page-client";
import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { CreditPack as DBCreditPack } from "@/lib/types";
import { BrandCard, CornerBrackets } from "@/components/brand";

// Local interface with credits as number for display
interface CreditPack {
  id: string;
  name: string;
  description: string | null;
  credits: number; // Converted from NUMERIC string
  price_cents: number;
  stripe_price_id: string;
  stripe_product_id: string;
  is_active: boolean;
  sort_order: number;
}

interface BillingPageWrapperProps {
  creditPacks: DBCreditPack[];
  currentCredits: number;
  canceled?: string;
}

export function BillingPageWrapper({
  creditPacks,
  currentCredits,
  canceled,
}: BillingPageWrapperProps) {
  useSetPageHeader({
    title: "Billing & Balance",
    description: "Add funds to power your AI generations",
  });

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      {canceled && (
        <Alert
          variant="destructive"
          className="rounded-none border-rose-500/40 bg-rose-500/10"
        >
          <Info className="h-4 w-4 text-rose-400" />
          <AlertTitle className="text-rose-400">Payment Canceled</AlertTitle>
          <AlertDescription className="text-rose-400">
            Your payment was canceled. No charges were made.
          </AlertDescription>
        </Alert>
      )}

      <BrandCard className="relative" corners={false}>
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 text-[#FF5800] mt-0.5 shrink-0" />
          <div>
            <h4 className="font-semibold text-white mb-1">How Billing Works</h4>
            <p className="text-sm text-white/60">
              You are charged for all AI operations including text generation,
              image creation, and video rendering. Add funds in bulk to get
              better rates. Your balance never expires and is shared across your
              organization.
            </p>
          </div>
        </div>
      </BrandCard>

      <BillingPageClient
        creditPacks={creditPacks.map((p) => ({
          ...p,
          credits: Number(p.credits),
        }))}
        currentCredits={currentCredits}
      />
    </div>
  );
}
