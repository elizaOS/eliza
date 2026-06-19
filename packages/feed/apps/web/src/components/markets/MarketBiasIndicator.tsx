/**
 * Market bias indicator component for displaying active market biases.
 *
 * Displays a list of active market biases and sentiment adjustments affecting
 * markets. Shows which entities are influencing markets, direction, strength,
 * and expiration times. Auto-refreshes every 30 seconds.
 *
 * Features:
 * - Active biases list
 * - Direction indicators (up/down)
 * - Strength display
 * - Price and sentiment adjustments
 * - Expiration times
 * - Auto-refresh (30s interval)
 * - Loading states
 * - Empty state handling
 *
 * @param props - MarketBiasIndicator component props
 * @returns Market bias indicator element
 *
 * @example
 * ```tsx
 * <MarketBiasIndicator
 *   maxDisplay={10}
 * />
 * ```
 */
"use client";

import { cn } from "@feed/shared";
import { Activity, Clock, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { apiUrl } from "@/utils/api-url";

/**
 * Bias adjustment structure for market bias indicator.
 */
interface BiasAdjustment {
  entityId: string;
  entityName: string;
  direction: "up" | "down";
  strength: number;
  priceAdjustment: number;
  sentimentAdjustment: number;
  expiresAt: string | null;
  decayRate: number;
}

/**
 * Bias data structure from API.
 */
interface BiasData {
  success: boolean;
  biases: BiasAdjustment[];
  count: number;
}

interface MarketBiasIndicatorProps {
  className?: string;
  maxDisplay?: number;
}

export function MarketBiasIndicator({
  className = "",
  maxDisplay = 10,
}: MarketBiasIndicatorProps) {
  const [data, setData] = useState<BiasData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchBiases = async () => {
      setLoading(true);
      const response = await fetch(apiUrl("/api/markets/bias/active"));
      const result = await response.json();

      if (result.success) {
        setData(result);
      }
      setLoading(false);
    };

    fetchBiases();

    // Refresh every 30 seconds
    const interval = setInterval(fetchBiases, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className={cn("rounded-lg bg-sidebar p-4", className)}>
        <div className="text-muted-foreground text-sm">
          Loading market biases...
        </div>
      </div>
    );
  }

  if (!data || data.biases.length === 0) {
    return (
      <div className={cn("rounded-lg bg-sidebar p-4", className)}>
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground text-sm">
            No active market biases
          </span>
        </div>
      </div>
    );
  }

  const displayBiases = data.biases.slice(0, maxDisplay);

  const getTimeRemaining = (expiresAt: string | null) => {
    if (!expiresAt) return "Permanent";

    const now = new Date();
    const expiry = new Date(expiresAt);
    const diff = expiry.getTime() - now.getTime();

    if (diff <= 0) return "Expired";

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <div className={cn("space-y-4 rounded-lg bg-sidebar p-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-foreground text-lg">
          <Activity className="h-5 w-5 text-blue-500" />
          Active Market Biases
        </h3>
        <div className="text-muted-foreground text-xs">{data.count} active</div>
      </div>

      {/* Bias List */}
      <div className="space-y-2">
        {displayBiases.map((bias) => (
          <div
            key={bias.entityId}
            className="rounded-lg bg-muted/30 p-3 transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center justify-between">
              {/* Entity Info */}
              <div className="flex flex-1 items-center gap-2">
                {bias.direction === "up" ? (
                  <TrendingUp className="h-5 w-5 shrink-0 text-green-500" />
                ) : (
                  <TrendingDown className="h-5 w-5 shrink-0 text-red-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">
                    {bias.entityName}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {bias.entityId}
                  </div>
                </div>
              </div>

              {/* Strength & Adjustments */}
              <div className="flex shrink-0 items-center gap-3">
                {/* Strength Bar */}
                <div className="hidden sm:block">
                  <div className="mb-1 text-muted-foreground text-xs">
                    Strength
                  </div>
                  <div className="h-2 w-20 rounded-full bg-muted/30">
                    <div
                      className={cn(
                        "h-2 rounded-full",
                        bias.direction === "up" ? "bg-green-500" : "bg-red-500",
                      )}
                      style={{ width: `${bias.strength * 100}%` }}
                    />
                  </div>
                </div>

                {/* Price Adjustment */}
                <div className="text-right">
                  <div
                    className="font-bold text-sm"
                    style={{
                      color:
                        bias.priceAdjustment >= 0
                          ? "rgb(34, 197, 94)"
                          : "rgb(239, 68, 68)",
                    }}
                  >
                    {bias.priceAdjustment >= 0 ? "+" : ""}
                    {(bias.priceAdjustment * 100).toFixed(1)}%
                  </div>
                  <div className="text-muted-foreground text-xs">Price</div>
                </div>

                {/* Sentiment */}
                <div className="hidden text-right md:block">
                  <div
                    className="font-medium text-sm"
                    style={{
                      color:
                        bias.sentimentAdjustment >= 0
                          ? "rgb(34, 197, 94)"
                          : "rgb(239, 68, 68)",
                    }}
                  >
                    {bias.sentimentAdjustment >= 0 ? "+" : ""}
                    {(bias.sentimentAdjustment * 100).toFixed(1)}%
                  </div>
                  <div className="text-muted-foreground text-xs">Sentiment</div>
                </div>
              </div>
            </div>

            {/* Duration & Decay */}
            <div className="mt-2 flex items-center gap-4 border-border/50 border-t pt-2">
              <div className="flex items-center gap-1 text-muted-foreground text-xs">
                <Clock className="h-3 w-3" />
                {getTimeRemaining(bias.expiresAt)}
              </div>
              {bias.decayRate > 0 && (
                <div className="text-muted-foreground text-xs">
                  Decay: {(bias.decayRate * 100).toFixed(0)}%/hr
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      {data.count > maxDisplay && (
        <div className="border-border border-t pt-2 text-center text-muted-foreground text-xs">
          Showing {maxDisplay} of {data.count} active biases
        </div>
      )}
    </div>
  );
}
