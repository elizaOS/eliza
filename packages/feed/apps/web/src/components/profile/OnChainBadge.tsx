"use client";

import { cn } from "@feed/shared";
import { Shield, ShieldCheck } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

interface OnChainBadgeProps {
  isRegistered: boolean;
  nftTokenId?: number | null;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}

export function OnChainBadge({
  isRegistered,
  nftTokenId,
  size = "md",
  showLabel = false,
  className,
}: OnChainBadgeProps) {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  if (isRegistered && nftTokenId) {
    return (
      <Tooltip
        content={
          <div className="space-y-1 text-xs">
            <p className="font-semibold text-green-500">Verified On-Chain</p>
            <p className="text-muted-foreground">NFT Token ID: #{nftTokenId}</p>
            <p className="text-muted-foreground">
              Blockchain identity verified
            </p>
          </div>
        }
      >
        <div className={cn("inline-flex items-center gap-1", className)}>
          <ShieldCheck
            className={cn(sizeClasses[size], "shrink-0 text-green-500")}
            fill="currentColor"
          />
          {showLabel && (
            <span className="font-medium text-green-600 text-xs dark:text-green-400">
              Verified On-Chain
            </span>
          )}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={
        <div className="space-y-1 text-xs">
          <p className="font-semibold text-muted-foreground">
            Not Verified On-Chain
          </p>
          <p className="text-muted-foreground/70">No blockchain identity</p>
          <p className="text-muted-foreground/70">
            Limited reputation features
          </p>
        </div>
      }
    >
      <div className={cn("inline-flex items-center gap-1", className)}>
        <Shield
          className={cn(sizeClasses[size], "shrink-0 text-muted-foreground/50")}
        />
        {showLabel && (
          <span className="font-medium text-muted-foreground text-xs">
            Not Verified
          </span>
        )}
      </div>
    </Tooltip>
  );
}
