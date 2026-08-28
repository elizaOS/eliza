"use client";

/**
 * Composed cloud dashboard pieces (empty states, quick cards) shared across dashboard routes.
 */
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
  Terminal,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../lib/utils";
import { DashboardTableSkeleton } from "../data-list/dashboard-table-skeleton";
import { DashboardRoutePage } from "../layout/dashboard-route-page";

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
        to="/cloud/my-agents"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-white p-5 text-black transition-colors hover:bg-black hover:text-white sm:col-span-2 xl:col-span-1"
      >
        <div className="mb-4 flex items-center justify-between">
          <Rocket className="size-5" />
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </div>
        <h3 className="text-base font-semibold">My Agent</h3>
      </Link>

      <div className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-border bg-black p-5 text-white sm:col-span-2 xl:col-span-1">
        <Code className="size-5" />
        <div>
          <h3 className="text-base font-semibold">API Access</h3>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium">
            <Link
              to="/cloud/api-keys"
              className="inline-flex items-center gap-1.5 hover:text-white"
            >
              <KeyRound className="size-3" />
              Keys
            </Link>
            <Link
              to="/docs"
              className="inline-flex items-center gap-1.5 hover:text-white"
            >
              <BookOpen className="size-3" />
              Docs
            </Link>
            <Link
              to="/cloud/api-explorer"
              className="inline-flex items-center gap-1.5 hover:text-white"
            >
              <Bot className="size-3" />
              Explorer
            </Link>
          </div>
        </div>
      </div>

      <Link
        to="/settings#cloud-billing"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Wallet className="size-5" />
          <span className="rounded-sm border border-white/15 bg-white/10 px-2 py-0.5 text-xs font-semibold text-white">
            {formattedBalance}
          </span>
        </div>
        <h3 className="text-base font-semibold">Billing</h3>
      </Link>

      <Link
        to="/cloud/agents"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Server className="size-5" />
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </div>
        <h3 className="text-base font-semibold">Agents</h3>
      </Link>

      <Link
        to="/cloud/apps"
        className="group relative flex min-h-[148px] flex-col justify-between rounded-sm border border-white/10 bg-black p-5 text-white transition-colors hover:bg-white/[0.06]"
      >
        <div className="flex items-center justify-between">
          <Store className="size-5" />
          <CreditCard className="size-4" />
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
          <Skeleton className="size-5" />
          <Skeleton className="h-5 w-28" />
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
  return <DashboardRoutePage title="Agents">{children}</DashboardRoutePage>;
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
  return (
    <DashboardTableSkeleton
      columns={[
        { key: "app", label: "App", skeletonClassName: "w-32" },
        { key: "status", label: "Status", skeletonClassName: "h-6 w-20" },
        { key: "revenue", label: "Revenue", skeletonClassName: "w-20" },
        { key: "updated", label: "Updated", skeletonClassName: "w-24" },
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

export function ContainersSkeleton() {
  return (
    <DashboardTableSkeleton
      // Columns mirror the normal-user Agents table so loading never flashes
      // implementation metadata that the settled product surface omits.
      columns={[
        { key: "agent", label: "Agent", skeletonClassName: "w-32" },
        { key: "status", label: "Status", skeletonClassName: "h-6 w-20" },
        { key: "webui", label: "Web UI", skeletonClassName: "w-16" },
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
  const commands = ["bun i -g elizaos", "elizaos deploy"];

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-6 rounded-sm bg-card py-12">
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
            <span className="select-none text-muted">$</span>
            <code className="flex-1 font-mono text-sm text-txt">{cmd}</code>
            <CopyButton
              value={cmd}
              copyLabel={`Copy ${cmd}`}
              copiedLabel="Copied"
            />
          </div>
        ))}
      </div>

      <Button variant="outlineMuted" asChild className="h-10">
        <a
          href="https://elizaos.github.io/eliza/docs/cli"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Terminal className="size-4" />
          CLI Documentation
        </a>
      </Button>
    </div>
  );
}

export type {
  AppsEmptyStateProps,
  DashboardActionCardsProps,
  DashboardRoutePageWrapperProps,
};
