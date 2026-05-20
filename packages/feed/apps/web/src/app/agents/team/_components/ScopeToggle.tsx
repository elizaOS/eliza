'use client';

import { cn } from '@feed/shared';
import type { TeamScope } from '@/lib/agents/team-trading-summary';

/**
 * Toggle between "Owner + Agents" and "Agents Only" scope.
 * Shared by TeamPnL and TeamPortfolio.
 */
export function ScopeToggle({
  scope,
  onChange,
}: {
  scope: TeamScope;
  onChange: (scope: TeamScope) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-muted/20 p-1 text-xs">
      <button
        type="button"
        onClick={() => onChange('owner_agents')}
        className={cn(
          'rounded px-2 py-1 font-medium transition-colors',
          scope === 'owner_agents'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
        )}
      >
        Owner + Agents
      </button>
      <button
        type="button"
        onClick={() => onChange('agents_only')}
        className={cn(
          'rounded px-2 py-1 font-medium transition-colors',
          scope === 'agents_only'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
        )}
      >
        Agents Only
      </button>
    </div>
  );
}
