/**
 * Endpoint card component displaying API endpoint information.
 * Shows method, path, description, pricing, and tags.
 */

"use client";

import { ChevronRight, Coins, Sparkles } from "lucide-react";
import { type ApiEndpoint, formatEndpointPrice } from "@/lib/swagger/endpoint-discovery";
import { cn } from "@/lib/utils";

interface EndpointCardProps {
  endpoint: ApiEndpoint;
  onSelect: (endpoint: ApiEndpoint) => void;
  getMethodColor: (method: string) => string;
  getCategoryIcon: (category: string) => React.ReactNode;
}

function getPricingTextStyle(pricing: ApiEndpoint["pricing"]) {
  if (!pricing) return "text-neutral-500";
  if (pricing.isFree) return "text-emerald-400";
  if (pricing.isVariable) return "text-amber-400";
  return "text-[#FF5800]";
}

export function EndpointCard({
  endpoint,
  onSelect,
  getMethodColor,
  getCategoryIcon,
}: EndpointCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(endpoint)}
      className="group relative w-full min-w-0 text-left bg-neutral-900/50 rounded-xl p-4 transition-all border border-white/5 hover:border-white/10 hover:bg-neutral-900/70 overflow-hidden"
    >
      {/* Hover indicator */}
      <div className="absolute right-4 top-4 opacity-0 transition-all duration-200 group-hover:opacity-100">
        <div className="flex items-center gap-1 text-xs font-medium text-[#FF5800]">
          Test <ChevronRight className="h-3 w-3" />
        </div>
      </div>

      <div className="space-y-3">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-neutral-500">{getCategoryIcon(endpoint.category)}</span>
            <h3 className="text-sm font-semibold text-white group-hover:text-[#FF5800] transition-colors pr-16">
              {endpoint.name}
            </h3>
          </div>
          <p className="text-xs text-neutral-500 line-clamp-2">{endpoint.description}</p>
        </div>

        {/* Method and path */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
              getMethodColor(endpoint.method),
            )}
          >
            {endpoint.method}
          </span>
          <code className="flex-1 text-xs font-mono text-neutral-400 truncate">
            {endpoint.path}
          </code>
        </div>

        {/* Footer with pricing and tags */}
        <div className="flex items-center justify-between pt-2 border-t border-white/5">
          {/* Pricing */}
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
              <span className="font-medium">{formatEndpointPrice(endpoint.pricing)}</span>
              {!endpoint.pricing.isFree && (
                <span className="opacity-60">/{endpoint.pricing.unit}</span>
              )}
            </div>
          ) : (
            <div />
          )}

          {/* Tags and deprecated badge */}
          <div className="flex items-center gap-2">
            {endpoint.deprecated && (
              <span className="text-[10px] text-rose-400 font-medium">Deprecated</span>
            )}
            {endpoint.tags.length > 0 && (
              <div className="flex gap-1">
                {endpoint.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 text-[10px] text-neutral-300 bg-white/10 rounded"
                  >
                    {tag}
                  </span>
                ))}
                {endpoint.tags.length > 2 && (
                  <span className="text-[10px] text-neutral-400">+{endpoint.tags.length - 2}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
