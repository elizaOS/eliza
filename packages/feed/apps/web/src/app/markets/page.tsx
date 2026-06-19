"use client";

export const dynamic = "force-dynamic";

import nextDynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "@/components/shared/PageContainer";
import { PositionsTab } from "@/components/wallet/v2/positions-tab";
import { useAuth } from "@/hooks/useAuth";
import { useUserPositionsPolling } from "@/stores/userPositionsStore";
import { invalidateWalletBalance } from "@/stores/walletBalanceStore";
import { MarketsTradingTerminal } from "./_components/terminal/MarketsTradingTerminal";

const BuyPointsModal = nextDynamic(
  () =>
    import("@/components/points/BuyPointsModal").then((m) => ({
      default: m.BuyPointsModal,
    })),
  { ssr: false },
);

/**
 * Markets route (`/markets`): page shell (layout, Stripe return handling, buy points modal).
 *
 * The full trading terminal UI — market list, charts, order entry, filters — is implemented
 * in `./_components/terminal/MarketsTradingTerminal.tsx`, not in this file.
 */
export default function MarketsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready, authenticated, user } = useAuth();
  const userId = authenticated ? user?.id : undefined;
  const [showBuyPointsModal, setShowBuyPointsModal] = useState(false);

  // Poll positions for the sidebar
  useUserPositionsPolling(userId ?? null);

  // Ref guard to prevent Stripe redirect effect from firing multiple times
  const stripeHandledRef = useRef(false);

  // Handle Stripe Checkout success/cancel redirects
  // When user returns from Stripe, show appropriate toast and clean URL
  useEffect(() => {
    // Prevent re-entry if already handled (can happen before router.replace completes)
    if (stripeHandledRef.current) return;

    const stripeSuccess = searchParams.get("stripe_success");
    const stripeCancelled = searchParams.get("stripe_cancelled");

    if (stripeSuccess === "true") {
      stripeHandledRef.current = true;
      // Payment received - points are credited via webhook asynchronously
      // Message is conservative since webhook timing is not guaranteed
      const showToast = () => {
        toast.success(
          "Payment received! Your points will be credited shortly.",
          {
            duration: 5000,
            description: "Your balance will update automatically.",
          },
        );
        invalidateWalletBalance();
      };
      // Small delay to allow webhook to complete (typically < 1 second)
      const timeout = setTimeout(showToast, 1000);

      // Clean up URL params after showing toast
      const url = new URL(window.location.href);
      url.searchParams.delete("stripe_success");
      url.searchParams.delete("session_id");
      router.replace(url.pathname + url.search, { scroll: false });

      return () => clearTimeout(timeout);
    } else if (stripeCancelled === "true") {
      stripeHandledRef.current = true;
      invalidateWalletBalance();
      // Clean up URL params
      const url = new URL(window.location.href);
      url.searchParams.delete("stripe_cancelled");
      router.replace(url.pathname + url.search, { scroll: false });
    }
    return undefined;
  }, [searchParams, router]);

  return (
    <PageContainer
      noPadding
      className="mt-14 flex h-[calc(100dvh-56px-var(--bottom-nav-height))] min-h-0 flex-col overflow-hidden md:mt-0 md:h-dvh"
    >
      <div className="relative flex flex-1 overflow-hidden">
        {/* Main trading terminal */}
        <div className="flex min-w-0 flex-1 flex-col border-border bg-background/20 lg:border-l">
          <MarketsTradingTerminal
            onRequestBuyPoints={() => setShowBuyPointsModal(true)}
          />
        </div>

        {/* Right sidebar — Positions (same as wallet page) */}
        {ready && authenticated && userId && (
          <div className="hidden w-96 flex-none flex-col overflow-y-auto border-border border-l xl:flex">
            <div className="p-4">
              <PositionsTab userId={userId} />
            </div>
          </div>
        )}
      </div>

      {showBuyPointsModal && (
        <BuyPointsModal
          isOpen={showBuyPointsModal}
          onClose={() => setShowBuyPointsModal(false)}
          onSuccess={() => {
            invalidateWalletBalance();
          }}
        />
      )}
    </PageContainer>
  );
}
