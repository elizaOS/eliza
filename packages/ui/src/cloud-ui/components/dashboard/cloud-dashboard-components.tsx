"use client";

import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  Code,
  Copy,
  CreditCard,
  KeyRound,
  Rocket,
  Server,
  Store,
  Terminal,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { BrandButton } from "../brand/brand-button";
import { DashboardTableSkeleton } from "../data-list/dashboard-table-skeleton";
import { EmptyState } from "../empty-state";
import { DashboardRoutePage } from "../layout/dashboard-route-page";
import { ListSkeleton } from "../list-skeleton";

interface DashboardActionLinkProps {
  to: string;
  className?: string;
  children: ReactNode;
}

interface DashboardActionCardsProps {
  /** null = balance unavailable. */
  creditBalance: number | null;
  className?: string;
  renderLink?: (props: DashboardActionLinkProps) => ReactNode;
}

interface AppsEmptyStateProps {
  /** Override the default app-first messaging if needed. */
  description?: string;
  /** Optional CTA. */
  action?: ReactNode;
}

interface DashboardRoutePageWrapperProps {
  children: ReactNode;
}

const ACTION_CARD_SKELETON_IDS = [
  "agent",
  "api",
  "billing",
  "instances",
  "apps",
];

function DefaultDashboardLink({
  to,
  className,
  children,
}: DashboardActionLinkProps) {
  return (
    <a href={to} className={className}>
      {children}
    </a>
  );
}

export function DashboardActionCards({
  creditBalance,
  className,
  renderLink = DefaultDashboardLink,
}: DashboardActionCardsProps) {
  const formattedBalance =
    creditBalance === null
      ? "-"
      : creditBalance >= 1
        ? `$${creditBalance.toFixed(2)}`
        : creditBalance > 0
          ? `$${creditBalance.toFixed(4)}`
          : "$0.00";

  const Link = renderLink;

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
            <Link
              to="/dashboard/api-keys"
              className="inline-flex items-center gap-1.5 hover:text-[#FF5800]"
            >
              <KeyRound className="h-3 w-3" />
              Keys
            </Link>
            <Link
              to="/docs"
              className="inline-flex items-center gap-1.5 hover:text-[#FF5800]"
            >
              <BookOpen className="h-3 w-3" />
              Docs
            </Link>
            <Link
              to="/dashboard/api-explorer"
              className="inline-flex items-center gap-1.5 hover:text-[#FF5800]"
            >
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
        to="/dashboard/agents"
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
          <div className="h-5 w-5 animate-pulse rounded-sm bg-white/10" />
          <div className="h-5 w-28 animate-pulse rounded-sm bg-white/10" />
        </div>
      ))}
    </div>
  );
}

export function DashboardPageWrapper({
  children,
}: DashboardRoutePageWrapperProps) {
  return <DashboardRoutePage title="Dashboard">{children}</DashboardRoutePage>;
}

export function AppsPageWrapper({ children }: DashboardRoutePageWrapperProps) {
  return <DashboardRoutePage title="My Apps">{children}</DashboardRoutePage>;
}

export function ContainersPageWrapper({
  children,
}: DashboardRoutePageWrapperProps) {
  return <DashboardRoutePage title="Containers">{children}</DashboardRoutePage>;
}

export function ElizaAgentsPageWrapper({
  children,
}: DashboardRoutePageWrapperProps) {
  return <DashboardRoutePage title="Instances">{children}</DashboardRoutePage>;
}

export function AppsEmptyState({ description, action }: AppsEmptyStateProps) {
  return (
    <EmptyState
      title="No apps yet"
      description={description}
      variant="minimal"
      action={action}
    />
  );
}

export function AppsSkeleton() {
  return <ListSkeleton rows={3} variant="card" />;
}

export function ContainersSkeleton() {
  return (
    <DashboardTableSkeleton
      columns={[
        { key: "name", label: "Name", skeletonClassName: "w-32" },
        { key: "status", label: "Status", skeletonClassName: "h-6 w-20" },
        { key: "port", label: "Port", skeletonClassName: "w-12" },
        { key: "instances", label: "Instances", skeletonClassName: "w-8" },
        { key: "deployed", label: "Deployed", skeletonClassName: "w-24" },
        {
          key: "actions",
          label: "Actions",
          cellClassName: "text-right",
          skeletonClassName: "ml-auto h-8 w-20",
        },
      ]}
    />
  );
}

export function ContainersEmptyState() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const commands = ["bun i -g @elizaos/cli", "elizaos deploy"];

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-6 rounded-sm bg-neutral-900 py-12">
      <div className="space-y-2 text-center">
        <h3 className="text-xl font-medium text-white">No containers yet</h3>
      </div>

      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-sm border border-white/10 bg-black/60">
        {commands.map((cmd, index) => (
          <div
            key={cmd}
            className={cn(
              "group flex items-center gap-3 px-4 py-3",
              index < commands.length - 1 && "border-b border-white/5",
            )}
          >
            <span className="select-none text-neutral-600">$</span>
            <code className="flex-1 font-mono text-sm text-neutral-300">
              {cmd}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(cmd, index)}
              className="rounded-sm text-neutral-600 transition-colors hover:text-neutral-300"
              aria-label={`Copy ${cmd}`}
            >
              {copiedIndex === index ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        ))}
      </div>

      <BrandButton
        variant="outline"
        asChild
        className="h-10 border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-white"
      >
        <a
          href="https://elizaos.github.io/eliza/docs/cli"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Terminal className="h-4 w-4" />
          CLI Documentation
        </a>
      </BrandButton>
    </div>
  );
}

export type {
  AppsEmptyStateProps,
  DashboardActionCardsProps,
  DashboardRoutePageWrapperProps,
};
