'use client';

import { cn } from '@feed/shared';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useAgentTotalPnL } from '@/hooks/useAgentTotalPnL';

/**
 * Displays agent total P&L (realized + unrealized).
 *
 * Uses the useAgentTotalPnL hook to fetch positions and calculate the true total.
 *
 * @example
 * ```tsx
 * <AgentPnLDisplay agentId={agent.id} realizedPnL={agent.lifetimePnL} />
 * ```
 */
interface AgentPnLDisplayProps {
  /** Agent ID used to fetch positions */
  agentId: string;
  /** Realized P&L from the agent record (lifetimePnL field) */
  realizedPnL: string | number;
  /** Show trending icon (default: false) */
  showIcon?: boolean;
  /** Additional className for the value */
  className?: string;
  /** Show "pts" suffix (default: true) */
  showSuffix?: boolean;
}

export function AgentPnLDisplay({
  agentId,
  realizedPnL,
  showIcon = false,
  className,
  showSuffix = true,
}: AgentPnLDisplayProps) {
  const {
    totalPnL,
    realizedPnL: parsedRealizedPnL,
    isProfitable,
    loading,
  } = useAgentTotalPnL(agentId, realizedPnL);

  // Use hook's parsed value to avoid duplicate parsing
  const displayValue = loading
    ? parsedRealizedPnL.toFixed(2)
    : totalPnL.toFixed(2);
  const suffix = showSuffix ? ' pts' : '';

  const Icon = isProfitable ? TrendingUp : TrendingDown;

  return (
    <span
      className={cn(
        'font-semibold',
        isProfitable ? 'text-green-600' : 'text-red-600',
        className
      )}
    >
      {showIcon && <Icon className="mr-1 inline h-3 w-3" />}
      {displayValue}
      {suffix}
    </span>
  );
}
