/**
 * Dashboard action cards — primary landing tiles. Flat brand surfaces.
 */

"use client";

import {
  ArrowRight,
  BookOpen,
  Bot,
  Code,
  CreditCard,
  KeyRound,
  Rocket,
  Server,
  Store,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface DashboardActionCardsProps {
  creditBalance: number;
  className?: string;
}

const ACTION_CARD_SKELETON_IDS = ["agent", "api", "billing", "instances", "apps"];

export function DashboardActionCards({
  creditBalance,
  className,
}: DashboardActionCardsProps) {
  const formattedBalance =
    creditBalance >= 1
      ? `$${creditBalance.toFixed(2)}`
      : creditBalance > 0
        ? `$${creditBalance.toFixed(4)}`
        : "$0.00";

  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-5", className)}>
      <Link
        to="/dashboard/my-agents"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-[#FF5800] p-5 text-black transition-colors hover:bg-black hover:text-white sm:col-span-2 xl:col-span-1"
      >
        <div className="mb-4 flex items-center justify-between">
          <Rocket className="h-5 w-5" />
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </div>
        <h3 className="text-base font-semibold">My Agent</h3>
      </Link>

      <div className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-[#0B35F1] p-5 text-white sm:col-span-2 xl:col-span-1">
        <Code className="h-5 w-5" />
        <div>
          <h3 className="text-base font-semibold">API Access</h3>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium">
            <Link to="/dashboard/api-keys" className="inline-flex items-center gap-1.5 hover:text-[#FF5800]">
              <KeyRound className="h-3 w-3" />
              Keys
            </Link>
            <Link to="/docs" className="inline-flex items-center gap-1.5 hover:text-[#FF5800]">
              <BookOpen className="h-3 w-3" />
              Docs
            </Link>
            <Link to="/dashboard/api-explorer" className="inline-flex items-center gap-1.5 hover:text-[#FF5800]">
              <Bot className="h-3 w-3" />
              Explorer
            </Link>
          </div>
        </div>
      </div>

      <Link
        to="/dashboard/billing"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Wallet className="h-5 w-5" />
          <span className="rounded-sm bg-[#FF5800] px-2 py-0.5 text-xs font-semibold text-black">
            {formattedBalance}
          </span>
        </div>
        <h3 className="text-base font-semibold">Billing</h3>
      </Link>

      <Link
        to="/dashboard/containers"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Server className="h-5 w-5" />
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </div>
        <h3 className="text-base font-semibold">Instances</h3>
      </Link>

      <Link
        to="/dashboard/apps"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Store className="h-5 w-5" />
          <CreditCard className="h-4 w-4" />
        </div>
        <h3 className="text-base font-semibold">Apps &amp; Monetization</h3>
      </Link>
    </div>
  );
}

export function DashboardActionCardsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {ACTION_CARD_SKELETON_IDS.map((id) => (
        <div
          key={id}
          className="flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-white/5 p-5"
        >
          <div className="h-5 w-5 animate-pulse bg-white/10" />
          <div className="h-5 w-28 animate-pulse bg-white/10" />
        </div>
      ))}
    </div>
  );
}
