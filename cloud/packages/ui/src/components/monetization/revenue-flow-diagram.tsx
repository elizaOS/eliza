/**
 * Revenue flow diagram component showing how money flows from users to creators.
 * Visual explanation of the monetization model.
 */

"use client";

import { ArrowRight, Coins, Server, User, Wallet, Zap } from "lucide-react";
import { cn } from "../../lib/utils";

interface RevenueFlowDiagramProps {
  markupPercentage: number;
  purchaseSharePercentage: number;
  className?: string;
}

export function RevenueFlowDiagram({
  markupPercentage,
  purchaseSharePercentage,
  className,
}: RevenueFlowDiagramProps) {
  // Example calculation with $1.00 base cost
  const baseCost = 1.0;
  const markup = baseCost * (markupPercentage / 100);
  const userPays = baseCost + markup;

  return (
    <div className={cn("bg-neutral-900 rounded-xl p-4 flex flex-col h-full", className)}>
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-sm font-medium text-white">How Revenue Flows</h3>
        <p className="text-xs text-neutral-500 mt-1">
          Example: User makes an AI request (${baseCost.toFixed(2)} base cost)
        </p>
      </div>

      {/* Flow Diagram */}
      <div className="pb-4">
        {/* Desktop/Tablet Layout */}
        <div className="hidden sm:flex items-center justify-between gap-2">
          {/* User */}
          <FlowNode
            icon={<User className="h-5 w-5" />}
            label="User"
            value={`Pays $${userPays.toFixed(2)}`}
            color="text-blue-400"
            bgColor="bg-blue-500/10"
          />

          {/* Arrow 1 */}
          <FlowArrow label={`$${userPays.toFixed(2)}`} />

          {/* Platform */}
          <FlowNode
            icon={<Server className="h-5 w-5" />}
            label="Platform"
            value={`Keeps $${baseCost.toFixed(2)}`}
            color="text-neutral-400"
            bgColor="bg-white/5"
          />

          {/* Arrow 2 */}
          <FlowArrow label={`$${markup.toFixed(2)}`} highlight />

          {/* Creator */}
          <FlowNode
            icon={<Wallet className="h-5 w-5" />}
            label="You"
            value={`Earn $${markup.toFixed(2)}`}
            color="text-[#FF5800]"
            bgColor="bg-[#FF5800]/10"
            highlight
          />
        </div>

        {/* Mobile Layout */}
        <div className="sm:hidden space-y-2">
          <FlowNodeMobile
            icon={<User className="h-4 w-4" />}
            label="User pays"
            value={`$${userPays.toFixed(2)}`}
            color="text-blue-400"
          />
          <div className="flex justify-center">
            <ArrowRight className="h-4 w-4 text-neutral-600 rotate-90" />
          </div>
          <FlowNodeMobile
            icon={<Server className="h-4 w-4" />}
            label="Platform keeps"
            value={`$${baseCost.toFixed(2)}`}
            color="text-neutral-400"
            sublabel="(base cost)"
          />
          <div className="flex justify-center">
            <ArrowRight className="h-4 w-4 text-[#FF5800] rotate-90" />
          </div>
          <FlowNodeMobile
            icon={<Wallet className="h-4 w-4" />}
            label="You earn"
            value={`$${markup.toFixed(2)}`}
            color="text-[#FF5800]"
            sublabel={`(${markupPercentage}% markup)`}
            highlight
          />
        </div>
      </div>

      {/* Breakdown */}
      <div className="mt-auto pt-4 border-t border-white/10">
        <div className="space-y-3 text-xs">
          <div className="flex items-start gap-2">
            <Zap className="h-3 w-3 text-purple-400 mt-0.5" />
            <div>
              <p className="font-medium text-purple-400">Inference Markup</p>
              <p className="text-neutral-500 mt-0.5">
                You set {markupPercentage}% markup on AI costs. More usage = more earnings.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Coins className="h-3 w-3 text-amber-400 mt-0.5" />
            <div>
              <p className="font-medium text-amber-400">Purchase Share</p>
              <p className="text-neutral-500 mt-0.5">
                Earn {purchaseSharePercentage}% when users buy credits in your app.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FlowNodeProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  bgColor: string;
  highlight?: boolean;
}

function FlowNode({ icon, label, value, color, bgColor, highlight }: FlowNodeProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 p-3 rounded-xl border transition-colors w-[90px]",
        highlight ? "border-[#FF5800]/30" : "border-white/10",
        bgColor,
      )}
    >
      <div className={cn(color)}>{icon}</div>
      <div className="text-center">
        <p className="text-xs font-medium text-white">{label}</p>
        <p className={cn("text-[10px] font-mono", color)}>{value}</p>
      </div>
    </div>
  );
}

interface FlowArrowProps {
  label: string;
  highlight?: boolean;
}

function FlowArrow({ label, highlight }: FlowArrowProps) {
  return (
    <div className="flex flex-col items-center gap-1 w-[50px]">
      <ArrowRight className={cn("h-4 w-4", highlight ? "text-[#FF5800]" : "text-neutral-600")} />
      <span
        className={cn("text-[10px] font-mono", highlight ? "text-[#FF5800]" : "text-neutral-500")}
      >
        {label}
      </span>
    </div>
  );
}

interface FlowNodeMobileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  sublabel?: string;
  highlight?: boolean;
}

function FlowNodeMobile({ icon, label, value, color, sublabel, highlight }: FlowNodeMobileProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between p-3 rounded-xl border",
        highlight ? "border-[#FF5800]/30 bg-[#FF5800]/10" : "border-white/10 bg-black/30",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={color}>{icon}</span>
        <div>
          <span className="text-xs text-white">{label}</span>
          {sublabel && <span className="text-[10px] text-neutral-500 ml-1">{sublabel}</span>}
        </div>
      </div>
      <span className={cn("text-sm font-mono font-medium", color)}>{value}</span>
    </div>
  );
}
