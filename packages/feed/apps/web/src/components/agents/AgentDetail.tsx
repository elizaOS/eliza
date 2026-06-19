/**
 * Agent Detail Component
 *
 * @description Reusable component for displaying agent details.
 * Used in both the standalone agent page and the Agents page.
 */

"use client";

import {
  Activity,
  ArrowLeft,
  Bot,
  ExternalLink,
  FileText,
  Settings,
  TrendingUp,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AgentPnLDisplay } from "@/components/agents/AgentPnLDisplay";
import { Avatar } from "@/components/shared/Avatar";
import { Skeleton } from "@/components/shared/Skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Performance: Lazy load tab components - only one is visible at a time
const AgentActivityFeed = dynamic(
  () =>
    import("@/components/agents/AgentActivityFeed").then((m) => ({
      default: m.AgentActivityFeed,
    })),
  { ssr: false, loading: () => <TabLoadingSkeleton /> },
);

const AgentLogs = dynamic(
  () =>
    import("@/components/agents/AgentLogs").then((m) => ({
      default: m.AgentLogs,
    })),
  { ssr: false, loading: () => <TabLoadingSkeleton /> },
);

const AgentPerformance = dynamic(
  () =>
    import("@/components/agents/AgentPerformance").then((m) => ({
      default: m.AgentPerformance,
    })),
  { ssr: false, loading: () => <TabLoadingSkeleton /> },
);

const AgentSettings = dynamic(
  () =>
    import("@/components/agents/AgentSettings").then((m) => ({
      default: m.AgentSettings,
    })),
  { ssr: false, loading: () => <TabLoadingSkeleton /> },
);

const AgentWallet = dynamic(
  () =>
    import("@/components/agents/AgentWallet").then((m) => ({
      default: m.AgentWallet,
    })),
  { ssr: false, loading: () => <TabLoadingSkeleton /> },
);

// Loading skeleton for tab content
function TabLoadingSkeleton() {
  return (
    <div className="space-y-4 p-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * Agent data structure
 */
export interface AgentDetailData {
  id: string;
  name: string;
  username?: string;
  description?: string;
  profileImageUrl?: string;
  system: string;
  bio?: string[];
  personality?: string;
  tradingStrategy?: string;
  virtualBalance?: number;
  totalDeposited?: number;
  totalWithdrawn?: number;
  isActive: boolean;
  autonomousEnabled: boolean;
  modelTier: "free" | "pro";
  status: string;
  errorMessage?: string;
  lifetimePnL: string;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
  lastTickAt?: string;
  lastChatAt?: string;
  a2aEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Available tab values for AgentDetail */
export type AgentDetailTab =
  | "activity"
  | "performance"
  | "logs"
  | "settings"
  | "wallet";

interface AgentDetailProps {
  /** Agent data to display */
  agent: AgentDetailData;
  /** Callback when agent data is updated (e.g., after settings change) */
  onUpdate?: () => void;
  /** Optional back button handler. If not provided, back button is hidden */
  onBack?: () => void;
  /** Back button label */
  backLabel?: string;
  /** Whether to show the component in compact mode (no page padding) */
  compact?: boolean;
  /** Default tab to show (defaults to 'activity') */
  defaultTab?: AgentDetailTab;
}

/**
 * Agent Detail Component
 *
 * Displays agent profile, stats, and management tabs.
 * Can be used standalone or embedded in other views.
 */
export function AgentDetail({
  agent,
  onUpdate,
  onBack,
  backLabel = "Back",
  compact = false,
  defaultTab = "activity",
}: AgentDetailProps) {
  const containerClass = compact
    ? "space-y-6"
    : "mx-auto max-w-7xl space-y-6 p-4";

  return (
    <div className={containerClass}>
      {/* Header with optional back button */}
      {onBack && (
        <div className="mb-8">
          <Button
            onClick={onBack}
            variant="ghost"
            className="mb-4 flex items-center gap-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-5 w-5" />
            <span>{backLabel}</span>
          </Button>
        </div>
      )}

      {/* Agent Info Card */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <div className="flex items-center gap-4">
          <Avatar
            id={agent.id}
            name={agent.name}
            type="user"
            size="lg"
            src={agent.profileImageUrl}
            imageUrl={agent.profileImageUrl}
          />
          <div className="flex-1">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="mb-1 font-bold text-2xl">{agent.name}</h1>
                {agent.username && (
                  <p className="mb-1 text-muted-foreground">
                    @{agent.username}
                  </p>
                )}
              </div>
              {agent.username && (
                <Link
                  href={`/profile/${agent.username}`}
                  className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                  View Profile
                </Link>
              )}
            </div>
            {agent.description && (
              <p className="mb-2 text-foreground/80">{agent.description}</p>
            )}
            <div className="flex items-center gap-4 text-sm">
              <span
                className={
                  agent.autonomousEnabled
                    ? "text-green-400"
                    : "text-foreground/80"
                }
              >
                {agent.autonomousEnabled ? (
                  <>
                    <Activity className="mr-1 inline h-3 w-3" />
                    Autonomous Active
                  </>
                ) : (
                  "Autonomous Disabled"
                )}
              </span>
              <span className="text-foreground">•</span>
              <span className="text-foreground/80 capitalize">
                {agent.modelTier} Mode
              </span>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="mt-6 grid grid-cols-2 place-items-center gap-4 border-border border-t pt-6 text-center">
          <div>
            <div className="mb-1 text-muted-foreground text-xs">Balance</div>
            <div className="font-semibold text-[#0066FF] text-xl">
              {(agent.virtualBalance ?? 0).toFixed(2)} pts
            </div>
          </div>
          <div>
            <div className="mb-1 text-muted-foreground text-xs">
              Lifetime P&L
            </div>
            <AgentPnLDisplay
              agentId={agent.id}
              realizedPnL={agent.lifetimePnL}
              className="text-xl"
            />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="grid w-full grid-cols-6 bg-muted/50">
          <TabsTrigger
            value="activity"
            className="data-[state=active]:bg-[#0066FF] data-[state=active]:text-primary-foreground"
          >
            <Activity className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">Activity</span>
          </TabsTrigger>
          <TabsTrigger
            value="performance"
            className="data-[state=active]:bg-[#0066FF] data-[state=active]:text-primary-foreground"
          >
            <TrendingUp className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">Performance</span>
          </TabsTrigger>
          <TabsTrigger
            value="logs"
            className="data-[state=active]:bg-[#0066FF] data-[state=active]:text-primary-foreground"
          >
            <FileText className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">Logs</span>
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="data-[state=active]:bg-[#0066FF] data-[state=active]:text-primary-foreground"
          >
            <Settings className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">Settings</span>
          </TabsTrigger>
          <TabsTrigger
            value="wallet"
            className="data-[state=active]:bg-[#0066FF] data-[state=active]:text-primary-foreground"
          >
            <Bot className="mr-2 h-4 w-4" />
            <span className="hidden sm:inline">Wallet</span>
          </TabsTrigger>
        </TabsList>

        <div className="mt-6">
          <TabsContent value="activity">
            <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
              <AgentActivityFeed
                agentId={agent.id}
                limit={50}
                showConnectionStatus={true}
                emptyMessage="No activity yet. Your agent will show trades, posts, and comments here."
              />
            </div>
          </TabsContent>

          <TabsContent value="performance">
            <AgentPerformance agent={agent} />
          </TabsContent>

          <TabsContent value="logs">
            <AgentLogs agentId={agent.id} />
          </TabsContent>

          <TabsContent value="settings">
            <AgentSettings agent={agent} onUpdate={onUpdate ?? (() => {})} />
          </TabsContent>

          <TabsContent value="wallet">
            <AgentWallet agent={agent} onUpdate={onUpdate ?? (() => {})} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

/** Loading skeleton for agent detail */
export function AgentDetailSkeleton({
  compact = false,
}: {
  compact?: boolean;
}) {
  const containerClass = compact
    ? "space-y-6"
    : "mx-auto max-w-7xl space-y-6 p-4";

  return (
    <div className={containerClass}>
      <Skeleton className="h-10 w-32" />
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

/** Empty state when agent not found */
export function AgentDetailNotFound({
  onBack,
  backLabel = "Back to Agents",
}: {
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="p-4">
      <div className="flex flex-col items-center justify-center rounded-lg border border-[#0066FF]/20 bg-gradient-to-br from-[#0066FF]/10 to-purple-500/10 px-4 py-16">
        <Bot className="mb-4 h-16 w-16 text-muted-foreground" />
        <h3 className="mb-2 font-bold text-2xl">Agent Not Found</h3>
        <p className="mb-6 text-muted-foreground text-sm">
          This agent doesn't exist or you don't have access to it
        </p>
        {onBack ? (
          <Button onClick={onBack}>{backLabel}</Button>
        ) : (
          <Link href="/agents">
            <Button>{backLabel}</Button>
          </Link>
        )}
      </div>
    </div>
  );
}
