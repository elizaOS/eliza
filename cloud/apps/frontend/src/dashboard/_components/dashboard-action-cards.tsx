/**
 * Dashboard action cards — the primary landing experience for users.
 * Shows quick-access cards for Chat, Create Agent, Billing/Credits, and Developer APIs.
 */

"use client";

import {
  ArrowRight,
  BookOpen,
  Bot,
  Code,
  Key,
  MessageSquare,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface DashboardActionCardsProps {
  creditBalance: number;
  className?: string;
}

export function DashboardActionCards({ creditBalance, className }: DashboardActionCardsProps) {
  const formattedBalance =
    creditBalance >= 1
      ? `$${creditBalance.toFixed(2)}`
      : creditBalance > 0
        ? `$${creditBalance.toFixed(4)}`
        : "$0.00";

  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {/* Model Playground */}
      <Link
        to="/dashboard/chat"
        className="group relative flex min-h-[156px] flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-orange-500/15 via-orange-600/10 to-transparent p-5 transition-all duration-300 hover:border-orange-500/40 hover:shadow-lg hover:shadow-orange-500/5"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/20 text-orange-400 transition-colors group-hover:bg-orange-500/30">
            <MessageSquare className="h-5 w-5" />
          </div>
          <ArrowRight className="h-4 w-4 text-white/30 transition-all duration-300 group-hover:translate-x-1 group-hover:text-orange-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Model Playground</h3>
          <p className="mt-1 text-sm text-white/50">Test prompts and compare models</p>
        </div>
        {/* Glow effect */}
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-orange-500/10 blur-3xl transition-opacity duration-500 group-hover:opacity-100 opacity-0" />
      </Link>

      {/* Create Agent */}
      <Link
        to="/dashboard/build"
        className="group relative flex min-h-[156px] flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-violet-500/15 via-violet-600/10 to-transparent p-5 transition-all duration-300 hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/5"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/20 text-violet-400 transition-colors group-hover:bg-violet-500/30">
            <Sparkles className="h-5 w-5" />
          </div>
          <ArrowRight className="h-4 w-4 text-white/30 transition-all duration-300 group-hover:translate-x-1 group-hover:text-violet-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Create an Agent</h3>
          <p className="mt-1 text-sm text-white/50">Build a custom agent</p>
        </div>
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-violet-500/10 blur-3xl transition-opacity duration-500 group-hover:opacity-100 opacity-0" />
      </Link>

      {/* Credits & Billing */}
      <Link
        to="/dashboard/billing"
        className="group relative flex min-h-[156px] flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-emerald-500/15 via-emerald-600/10 to-transparent p-5 transition-all duration-300 hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/5"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 transition-colors group-hover:bg-emerald-500/30">
            <Wallet className="h-5 w-5" />
          </div>
          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">
            {formattedBalance}
          </span>
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Credits &amp; Billing</h3>
          <p className="mt-1 text-sm text-white/50">Top up credits and view usage</p>
        </div>
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-3xl transition-opacity duration-500 group-hover:opacity-100 opacity-0" />
      </Link>

      {/* Developer APIs */}
      <div className="group relative flex min-h-[156px] flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-cyan-500/15 via-cyan-600/10 to-transparent p-5 transition-all duration-300 hover:border-cyan-500/40 hover:shadow-lg hover:shadow-cyan-500/5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-400 transition-colors group-hover:bg-cyan-500/30">
            <Code className="h-5 w-5" />
          </div>
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Developer APIs</h3>
          <p className="mt-1 mb-3 text-sm text-white/50">Build with the API</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/dashboard/api-keys"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 transition-colors hover:text-cyan-300"
            >
              <Key className="h-3 w-3" />
              API Keys
            </Link>
            <Link
              to="/docs"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 transition-colors hover:text-cyan-300"
            >
              <BookOpen className="h-3 w-3" />
              Docs
            </Link>
            <Link
              to="/dashboard/api-explorer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-400 transition-colors hover:text-cyan-300"
            >
              <Bot className="h-3 w-3" />
              Explorer
            </Link>
          </div>
        </div>
        <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-cyan-500/10 blur-3xl transition-opacity duration-500 group-hover:opacity-100 opacity-0" />
      </div>
    </div>
  );
}

export function DashboardActionCardsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="flex flex-col justify-between rounded-xl border border-white/10 bg-white/5 p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="h-10 w-10 rounded-lg bg-white/10 animate-pulse" />
            <div className="h-4 w-4 rounded bg-white/10 animate-pulse" />
          </div>
          <div className="space-y-2">
            <div className="h-5 w-28 rounded bg-white/10 animate-pulse" />
            <div className="h-4 w-full rounded bg-white/10 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
