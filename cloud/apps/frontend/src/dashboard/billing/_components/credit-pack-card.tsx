/**
 * Credit pack card component displaying credit pack information and purchase button.
 * Shows credits, price, price per credit, and popular badge.
 *
 * @param props - Credit pack card configuration
 * @param props.id - Credit pack ID
 * @param props.name - Credit pack name
 * @param props.description - Credit pack description
 * @param props.credits - Number of credits in pack
 * @param props.priceCents - Price in cents
 * @param props.isPopular - Whether pack is marked as popular
 * @param props.onPurchase - Callback when purchase button is clicked
 * @param props.loading - Whether purchase is in progress
 */

"use client";

import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Check, Clock, Sparkles } from "lucide-react";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { packSavingsPercent } from "@/lib/constants/agent-pricing-display";
import { cn } from "@/lib/utils";

interface CreditPackCardProps {
  id: string;
  name: string;
  description: string | null;
  credits: number | string; // NUMERIC from DB returns string
  priceCents: number;
  isPopular?: boolean;
  onPurchase: (id: string) => void;
  loading?: boolean;
}

export function CreditPackCard({
  id,
  name,
  description,
  credits,
  priceCents,
  isPopular = false,
  onPurchase,
  loading = false,
}: CreditPackCardProps) {
  const price = (priceCents / 100).toFixed(2);
  const creditsValue = Number(credits);
  const pricePerCredit = (priceCents / creditsValue / 100).toFixed(3);
  const savingsPercent = packSavingsPercent(priceCents, creditsValue);

  // How many months of 1 running agent this pack covers
  const agentMonths =
    Math.round((creditsValue / (AGENT_PRICING.RUNNING_HOURLY_RATE * 24 * 30)) * 10) / 10;

  return (
    <BrandCard
      className={cn(
        "relative overflow-hidden transition-all",
        isPopular && "border-[#FF5800] ring-2 ring-[#FF5800]/40",
      )}
    >
      <CornerBrackets size="sm" className="opacity-50" />

      {isPopular && (
        <div className="absolute top-0 right-0 z-10">
          <span className="rounded-bl-lg bg-[#FF5800] px-3 py-1 text-xs font-bold uppercase tracking-wide text-white inline-flex items-center">
            <Sparkles className="mr-1 h-3 w-3" />
            Popular
          </span>
        </div>
      )}

      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-2xl font-bold text-white">{name}</h3>
          <p className="text-sm text-white/60 mt-1">{description}</p>
        </div>

        <div>
          <div className="flex items-baseline gap-2">
            <div className="text-4xl font-bold text-white">${price}</div>
            {savingsPercent > 0 && (
              <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5">
                Save {savingsPercent}%
              </span>
            )}
          </div>
          <div className="text-sm text-white/50">${pricePerCredit} per credit</div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-white/60">
            <Check className="h-4 w-4 text-[#FF5800]" />
            <span>Never expires</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-white/60">
            <Clock className="h-4 w-4 text-[#FF5800]/70" />
            <span>
              ~{agentMonths} {agentMonths === 1 ? "month" : "months"} of 1 agent
            </span>
          </div>
        </div>

        <div className="pt-4 border-t border-white/10">
          <BrandButton
            onClick={() => onPurchase(id)}
            disabled={loading}
            variant={isPopular ? "primary" : "outline"}
            className="w-full"
            size="lg"
          >
            {loading ? "Processing..." : "Add Funds"}
          </BrandButton>
        </div>
      </div>
    </BrandCard>
  );
}
