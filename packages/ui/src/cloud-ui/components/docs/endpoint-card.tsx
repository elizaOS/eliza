"use client";

import { ChevronRight, Coins, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../lib/utils";

export interface ApiEndpointCardPricing {
  cost?: number;
  unit?: string;
  isFree?: boolean;
  isVariable?: boolean;
  estimatedRange?: {
    min: number;
    max: number;
  };
}

export interface ApiEndpointCardEndpoint {
  name: string;
  description: string;
  method: string;
  path: string;
  category: string;
  tags: string[];
  deprecated?: boolean;
  pricing?: ApiEndpointCardPricing;
}

export interface EndpointCardProps<
  TEndpoint extends ApiEndpointCardEndpoint = ApiEndpointCardEndpoint,
> {
  endpoint: TEndpoint;
  onSelect: (endpoint: TEndpoint) => void;
  getMethodColor: (method: string) => string;
  getCategoryIcon: (category: string) => ReactNode;
  formatPricing?: (pricing: NonNullable<TEndpoint["pricing"]>) => string;
}

function getPricingTextStyle(pricing: ApiEndpointCardPricing | undefined) {
  if (!pricing) return "text-neutral-500";
  if (pricing.isFree) return "text-green-400";
  if (pricing.isVariable) return "text-orange-400";
  return "text-[#FF5800]";
}

function fallbackPricingLabel(pricing: ApiEndpointCardPricing) {
  if (pricing.isFree) return "Free";
  if (pricing.isVariable && pricing.estimatedRange) {
    return `$${pricing.estimatedRange.min.toFixed(3)} - $${pricing.estimatedRange.max.toFixed(2)}`;
  }
  if (typeof pricing.cost === "number") {
    return `$${pricing.cost.toFixed(pricing.cost < 0.01 ? 4 : 2)}`;
  }
  return "Credits";
}

export function EndpointCard<
  TEndpoint extends ApiEndpointCardEndpoint = ApiEndpointCardEndpoint,
>({
  endpoint,
  onSelect,
  getMethodColor,
  getCategoryIcon,
  formatPricing,
}: EndpointCardProps<TEndpoint>) {
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => onSelect(endpoint)}
      className="group relative w-full min-w-0 overflow-hidden rounded-sm border border-white/5 bg-neutral-900/50 p-4 text-left transition-all hover:border-white/10 hover:bg-neutral-900/70"
    >
      <div className="absolute right-4 top-4 opacity-0 transition-all duration-200 group-hover:opacity-100">
        <div className="flex items-center gap-1 text-xs font-medium text-[#FF5800]">
          Test <ChevronRight className="h-3 w-3" />
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-neutral-500">
              {getCategoryIcon(endpoint.category)}
            </span>
            <h3 className="pr-16 text-sm font-semibold text-white transition-colors group-hover:text-[#FF5800]">
              {endpoint.name}
            </h3>
          </div>
          <p className="line-clamp-2 text-xs text-neutral-500">
            {endpoint.description}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase",
              getMethodColor(endpoint.method),
            )}
          >
            {endpoint.method}
          </span>
          <code className="flex-1 truncate font-mono text-xs text-neutral-400">
            {endpoint.path}
          </code>
        </div>

        <div className="flex items-center justify-between border-t border-white/5 pt-2">
          {endpoint.pricing ? (
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs",
                getPricingTextStyle(endpoint.pricing),
              )}
            >
              {endpoint.pricing.isFree ? (
                <Sparkles className="h-3 w-3" />
              ) : (
                <Coins className="h-3 w-3" />
              )}
              <span className="font-medium">
                {formatPricing
                  ? formatPricing(
                      endpoint.pricing as NonNullable<TEndpoint["pricing"]>,
                    )
                  : fallbackPricingLabel(endpoint.pricing)}
              </span>
              {!endpoint.pricing.isFree && endpoint.pricing.unit && (
                <span className="opacity-60">/{endpoint.pricing.unit}</span>
              )}
            </div>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            {endpoint.deprecated && (
              <span className="text-[10px] font-medium text-red-400">
                Deprecated
              </span>
            )}
            {endpoint.tags.length > 0 && (
              <div className="flex gap-1">
                {endpoint.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300"
                  >
                    {tag}
                  </span>
                ))}
                {endpoint.tags.length > 2 && (
                  <span className="text-[10px] text-neutral-400">
                    +{endpoint.tags.length - 2}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Button>
  );
}
