/**
 * Earnings simulator component for visualizing potential earnings.
 * Shows "what if" scenarios based on user count and spend amounts.
 */

"use client";

import { Calculator, Coins, DollarSign, TrendingUp, Users, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { Slider } from "../slider";

interface EarningsSimulatorProps {
  markupPercentage: number;
  purchaseSharePercentage: number;
  className?: string;
}

export function EarningsSimulator({
  markupPercentage,
  purchaseSharePercentage,
  className,
}: EarningsSimulatorProps) {
  const [users, setUsers] = useState(100);
  const [spendPerUser, setSpendPerUser] = useState(10);

  const calculations = useMemo(() => {
    const totalSpend = users * spendPerUser;

    // Inference earnings: users spend on AI, creator gets markup
    // Assume 80% of spend goes to inference costs
    const inferenceSpend = totalSpend * 0.8;
    const inferenceEarnings = inferenceSpend * (markupPercentage / 100);

    // Purchase earnings: creator gets % of credit purchases
    // Assume 20% of spend is new credit purchases
    const purchaseSpend = totalSpend * 0.2;
    const purchaseEarnings = purchaseSpend * (purchaseSharePercentage / 100);

    const totalEarnings = inferenceEarnings + purchaseEarnings;

    return {
      totalSpend,
      inferenceEarnings,
      purchaseEarnings,
      totalEarnings,
    };
  }, [users, spendPerUser, markupPercentage, purchaseSharePercentage]);

  return (
    <div className={cn("bg-neutral-900 rounded-xl p-4", className)}>
      {/* Header */}
      <h3 className="text-sm font-medium text-white flex items-center gap-2 mb-4">
        <Calculator className="h-4 w-4 text-purple-400" />
        Earnings Calculator
      </h3>

      {/* Inputs */}
      <div className="space-y-4 mb-4">
        {/* Users slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 flex items-center gap-1.5">
              <Users className="h-3 w-3" />
              Monthly Active Users
            </span>
            <span className="text-sm font-mono text-white">{users}</span>
          </div>
          <Slider
            value={[users]}
            onValueChange={([v]) => setUsers(v)}
            min={10}
            max={1000}
            step={10}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-neutral-600">
            <span>10</span>
            <span>1,000</span>
          </div>
        </div>

        {/* Spend per user slider */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400 flex items-center gap-1.5">
              <DollarSign className="h-3 w-3" />
              Avg. Spend per User
            </span>
            <span className="text-sm font-mono text-white">${spendPerUser}</span>
          </div>
          <Slider
            value={[spendPerUser]}
            onValueChange={([v]) => setSpendPerUser(v)}
            min={1}
            max={100}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-neutral-600">
            <span>$1</span>
            <span>$100</span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-white/10 mb-4" />

      {/* Results */}
      <div className="space-y-2">
        <p className="text-xs text-neutral-500 flex items-center gap-1.5 mb-3">
          <TrendingUp className="h-3 w-3" />
          Estimated Monthly Earnings
        </p>

        {/* Total Spend */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-400">Total User Spend</span>
          <span className="font-mono text-neutral-300">${calculations.totalSpend.toFixed(2)}</span>
        </div>

        {/* Inference earnings */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-purple-400 flex items-center gap-1.5">
            <Zap className="h-3 w-3" />
            Inference ({markupPercentage}%)
          </span>
          <span className="font-mono text-purple-400">
            +${calculations.inferenceEarnings.toFixed(2)}
          </span>
        </div>

        {/* Purchase earnings */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-amber-400 flex items-center gap-1.5">
            <Coins className="h-3 w-3" />
            Purchase ({purchaseSharePercentage}%)
          </span>
          <span className="font-mono text-amber-400">
            +${calculations.purchaseEarnings.toFixed(2)}
          </span>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/10 my-2" />

        {/* Total */}
        <div className="flex items-center justify-between">
          <span className="text-white font-medium">Your Earnings</span>
          <span className="text-xl font-semibold text-[#FF5800]">
            ${calculations.totalEarnings.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
