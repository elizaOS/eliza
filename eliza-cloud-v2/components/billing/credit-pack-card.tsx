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

import { Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandCard, BrandButton, CornerBrackets } from "@/components/brand";

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
          <div className="text-4xl font-bold text-white">${price}</div>
          <div className="text-sm text-white/50">
            ${pricePerCredit} per dollar
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm text-white/60">
          <Check className="h-4 w-4 text-[#FF5800]" />
          <span>Never expires</span>
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
