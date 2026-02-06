/**
 * Billing page client component for purchasing credit packs.
 * Displays available credit packs and handles Stripe checkout session creation.
 *
 * @param props - Billing page configuration
 * @param props.creditPacks - Array of available credit packs
 * @param props.currentCredits - User's current credit balance
 */

"use client";

import { useState, useEffect } from "react";
import { CreditPackCard } from "./credit-pack-card";
import { toast } from "sonner";
import { trackEvent } from "@/lib/analytics/posthog";

interface CreditPack {
  id: string;
  name: string;
  description: string | null;
  credits: number;
  price_cents: number;
  stripe_price_id: string;
  is_active: boolean;
  sort_order: number;
}

interface BillingPageClientProps {
  creditPacks: CreditPack[];
  currentCredits: number;
}

export function BillingPageClient({
  creditPacks,
  currentCredits,
}: BillingPageClientProps) {
  const [loading, setLoading] = useState<string | null>(null);

  // Track billing page viewed - only on initial mount
  useEffect(() => {
    trackEvent("billing_page_viewed", {
      current_credits: currentCredits,
      available_packs: creditPacks.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally track only on mount
  }, []);

  const handlePurchase = async (creditPackId: string) => {
    setLoading(creditPackId);

    // Find the pack being purchased for tracking
    const pack = creditPacks.find((p) => p.id === creditPackId);
    if (pack) {
      trackEvent("credits_purchase_started", {
        pack_id: creditPackId,
        pack_name: pack.name,
        credits: pack.credits,
        price_cents: pack.price_cents,
      });
    }

    try {
      const response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ creditPackId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to create checkout session");
      }

      const { url } = await response.json();

      if (!url) {
        throw new Error("No checkout URL returned");
      }

      window.location.href = url;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Purchase failed";
      toast.error(errorMessage);
    } finally {
      setLoading(null);
    }
  };

  // Determine which pack is popular (middle one)
  const middleIndex = Math.floor(creditPacks.length / 2);

  return (
    <div className="space-y-8">
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Balance</h3>
          <div className="text-3xl font-bold">
            ${Number(currentCredits).toFixed(2)}
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {creditPacks.map((pack, index) => (
          <CreditPackCard
            key={pack.id}
            id={pack.id}
            name={pack.name}
            description={pack.description}
            credits={pack.credits}
            priceCents={pack.price_cents}
            isPopular={index === middleIndex}
            onPurchase={handlePurchase}
            loading={loading === pack.id}
          />
        ))}
      </div>
    </div>
  );
}
