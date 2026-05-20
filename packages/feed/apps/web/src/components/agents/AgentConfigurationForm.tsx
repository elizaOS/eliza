'use client';

import { cn, GROQ_MODELS } from '@babylon/shared';
import { Copy, ExternalLink, Info } from 'lucide-react';
import { memo } from 'react';
import { Switch } from '@/components/ui/switch';
import { MODEL_TIER_POINTS_COST } from '@/lib/constants';

export interface AgentConfigurationData {
  modelTier: 'free' | 'pro';
  /**
   * Controls autonomous trading capability for the agent.
   *
   * TODO(tech-debt): Unify field naming across the stack. Currently:
   * - Frontend: `autonomousEnabled` (this prop)
   * - DB schema: `autonomousTrading` (packages/db/src/schema/user-agent-configs.ts)
   * - API translation: handled in agent creation/update routes
   *
   * Planned refactor: rename to `autonomousTrading` everywhere for consistency
   * with other autonomous toggles (autonomousPosting, autonomousCommenting, etc.)
   * and remove the API translation layer.
   *
   * @see packages/db/src/schema/user-agent-configs.ts - autonomousTrading field
   * @see apps/web/src/app/api/agents/[agentId]/route.ts - API translation
   */
  autonomousEnabled: boolean;
  autonomousPosting: boolean;
  autonomousCommenting: boolean;
  autonomousDMs: boolean;
  autonomousGroupChats: boolean;
  a2aEnabled: boolean;
}

interface AgentConfigurationFormProps {
  data: AgentConfigurationData;
  onChange: (data: AgentConfigurationData) => void;
  /** If provided, shows the A2A server link section when a2aEnabled is true */
  agentId?: string;
}

/**
 * Shared configuration form for Model Tier and Autonomous Features.
 * Used in both agent creation flow and agent settings page.
 */
export const AgentConfigurationForm = memo(function AgentConfigurationForm({
  data,
  onChange,
  agentId,
}: AgentConfigurationFormProps) {
  const updateField = <K extends keyof AgentConfigurationData>(
    key: K,
    value: AgentConfigurationData[K]
  ) => {
    onChange({ ...data, [key]: value });
  };

  return (
    <div className="space-y-4">
      {/* Model Tier Selection */}
      <div>
        <h3 className="mb-2 font-semibold text-sm">Model Tier</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            type="button"
            onClick={() => updateField('modelTier', 'free')}
            className={cn(
              'flex flex-1 flex-col justify-start rounded-lg border p-3 text-left transition-colors',
              data.modelTier === 'free'
                ? 'border-[#0066FF] bg-[#0066FF]/10'
                : 'border-border hover:border-[#0066FF]/50'
            )}
          >
            <div className="font-medium text-sm">
              Free ({GROQ_MODELS.FREE.displayName})
            </div>
            <div className="text-muted-foreground text-xs">
              {GROQ_MODELS.FREE.description}
            </div>
          </button>
          <button
            type="button"
            onClick={() => updateField('modelTier', 'pro')}
            className={cn(
              'flex flex-1 flex-col justify-start rounded-lg border p-3 text-left transition-colors',
              data.modelTier === 'pro'
                ? 'border-[#0066FF] bg-[#0066FF]/10'
                : 'border-border hover:border-[#0066FF]/50'
            )}
          >
            <div className="font-medium text-sm">
              Pro ({GROQ_MODELS.PRO.displayName})
            </div>
            <div className="text-muted-foreground text-xs">
              {GROQ_MODELS.PRO.description}
            </div>
            <div className="mt-1 font-medium text-[#0066FF] text-xs">
              {MODEL_TIER_POINTS_COST.pro} point per message
            </div>
          </button>
        </div>
      </div>

      {/* Autonomous Features */}
      <div>
        <h3 className="mb-2 font-semibold text-sm">Autonomous Features</h3>

        {/* Info banner - compact */}
        <div
          role="status"
          className="mb-3 flex items-start gap-2 text-muted-foreground text-xs"
        >
          <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p>
            {data.autonomousEnabled
              ? 'Trading enabled — agent will evaluate markets and execute trades. View in Activity tab.'
              : 'Trading disabled — enable below to allow autonomous market evaluation and trades.'}
          </p>
        </div>

        {/* Toggles in 2-column grid */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Autonomous Trading</div>
              <div className="text-muted-foreground text-xs">
                Execute trades on markets
              </div>
            </div>
            <Switch
              checked={data.autonomousEnabled}
              onCheckedChange={(checked) =>
                updateField('autonomousEnabled', checked)
              }
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Autonomous Posting</div>
              <div className="text-muted-foreground text-xs">
                Create posts automatically
              </div>
            </div>
            <Switch
              checked={data.autonomousPosting}
              onCheckedChange={(checked) =>
                updateField('autonomousPosting', checked)
              }
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Autonomous Commenting</div>
              <div className="text-muted-foreground text-xs">
                Comment on posts in feed
              </div>
            </div>
            <Switch
              checked={data.autonomousCommenting}
              onCheckedChange={(checked) =>
                updateField('autonomousCommenting', checked)
              }
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Autonomous DMs</div>
              <div className="text-muted-foreground text-xs">
                Respond to direct messages
              </div>
            </div>
            <Switch
              checked={data.autonomousDMs}
              onCheckedChange={(checked) =>
                updateField('autonomousDMs', checked)
              }
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Autonomous Group Chats</div>
              <div className="text-muted-foreground text-xs">
                Participate in group chats
              </div>
            </div>
            <Switch
              checked={data.autonomousGroupChats}
              onCheckedChange={(checked) =>
                updateField('autonomousGroupChats', checked)
              }
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 transition-all hover:bg-muted/50">
            <div className="min-w-0">
              <div className="font-medium text-sm">Enable A2A Server</div>
              <div className="text-muted-foreground text-xs">
                Connect via A2A protocol
              </div>
            </div>
            <Switch
              checked={data.a2aEnabled}
              onCheckedChange={(checked) => updateField('a2aEnabled', checked)}
              className="shrink-0"
            />
          </div>
        </div>

        {/* A2A Server Link - only shown for existing agents */}
        {data.a2aEnabled && agentId && (
          <div className="mt-3 rounded-lg border border-[#0066FF]/20 bg-[#0066FF]/10 p-3">
            <div className="mb-1 font-medium text-sm">A2A Server Link</div>
            <div className="flex items-center gap-2 rounded border border-border bg-background p-2">
              <code className="flex-1 overflow-x-auto break-all text-xs">
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/api/agents/${agentId}/a2a`
                  : `/api/agents/${agentId}/a2a`}
              </code>
              <button
                onClick={() => {
                  const url =
                    typeof window !== 'undefined'
                      ? `${window.location.origin}/api/agents/${agentId}/a2a`
                      : `/api/agents/${agentId}/a2a`;
                  navigator.clipboard.writeText(url);
                }}
                className="shrink-0 rounded p-1.5 transition-colors hover:bg-muted"
                title="Copy link"
              >
                <Copy className="h-4 w-4" />
              </button>
              <a
                href={
                  typeof window !== 'undefined'
                    ? `${window.location.origin}/api/agents/${agentId}/.well-known/agent-card`
                    : `/api/agents/${agentId}/.well-known/agent-card`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded p-1.5 transition-colors hover:bg-muted"
                title="View agent card"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
