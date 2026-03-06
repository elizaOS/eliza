/**
 * Containers section component displaying deployed containers table on dashboard.
 * Shows container count and provides link to full containers page.
 *
 * @param props - Containers section configuration
 * @param props.containers - Array of container objects
 * @param props.className - Additional CSS classes
 */

"use client";

import * as React from "react";
import { BrandButton } from "@/components/brand";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Terminal, Info, Copy, Check } from "lucide-react";
import Link from "next/link";
import { ContainersTable } from "@/components/containers/containers-table";
import { ContainersSkeleton } from "@/components/containers/containers-skeleton";

// Simplified container type matching getDashboardData output
interface DashboardContainer {
  id: string;
  name: string;
  description: string | null;
  status: string;
  ecs_service_arn: string | null;
  load_balancer_url: string | null;
  port: number;
  desired_count: number;
  cpu: number;
  memory: number;
  last_deployed_at: Date | null;
  created_at: Date;
  error_message: string | null;
}

interface ContainersSectionProps {
  containers: DashboardContainer[];
  className?: string;
}

export function ContainersSection({
  containers,
  className,
}: ContainersSectionProps) {
  const runningContainers = containers.filter((c) => c.status === "running");

  return (
    <div className={cn("space-y-4", className)}>
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/containers"
              className="text-xl font-semibold text-white transition-colors duration-200 hover:text-orange-500"
            >
              Containers
            </Link>
            <span className="text-base text-white/50">
              ({containers.length})
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-white/40 hover:text-white/70 transition-colors"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="max-w-[180px] text-xs bg-zinc-900 text-white/80 border border-white/10"
              >
                Cloud-hosted elizaOS instances running 24/7.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {containers.length > 4 && (
          <BrandButton
            variant="outline"
            asChild
            size="sm"
            className="h-8 text-xs"
          >
            <Link href="/dashboard/containers">View All</Link>
          </BrandButton>
        )}
      </div>

      {/* Containers Content */}
      {containers.length === 0 ? (
        <ContainersEmptyState />
      ) : (
        <ContainersTable containers={containers} />
      )}
    </div>
  );
}

// Empty State
function ContainersEmptyState() {
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null);
  const commands = ["bun i -g @elizaos/cli", "elizaos deploy"];

  const handleCopy = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[240px] gap-5 bg-neutral-900 rounded-xl py-8">
      <h3 className="text-lg font-medium text-neutral-500">
        No containers yet
      </h3>

      {/* CLI Instructions */}
      <div className="flex flex-col bg-black/60 rounded-lg border border-white/5 overflow-hidden w-full max-w-xs">
        {commands.map((cmd, index) => (
          <div
            key={index}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 group",
              index < commands.length - 1 && "border-b border-white/5",
            )}
          >
            <span className="text-neutral-600 select-none">$</span>
            <code className="text-sm text-neutral-400 flex-1">{cmd}</code>
            <button
              onClick={() => handleCopy(cmd, index)}
              className="text-neutral-600 hover:text-neutral-300 transition-colors"
            >
              {copiedIndex === index ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>

      <BrandButton
        variant="outline"
        asChild
        className="h-9 md:h-10 text-neutral-400 border-neutral-700 hover:text-white hover:border-neutral-600"
      >
        <Link href="/dashboard/containers">
          <Terminal className="h-4 w-4" />
          Learn More
        </Link>
      </BrandButton>
    </div>
  );
}

// Skeleton Loader
export function ContainersSectionSkeleton() {
  return (
    <div className="space-y-6">
      {/* Section Header Skeleton */}
      <div className="flex items-center justify-between">
        <div>
          <div className="h-8 w-48 bg-white/10 animate-pulse rounded" />
          <div className="h-4 w-64 bg-white/10 animate-pulse rounded mt-2" />
        </div>
        <div className="h-10 w-24 bg-white/10 animate-pulse rounded" />
      </div>

      {/* Table Skeleton */}
      <ContainersSkeleton />
    </div>
  );
}
