import {
  ArrowRight,
  Bot,
  Check,
  ChevronLeft,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type * as React from "react";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import { StatusBadge } from "../components/ui/status-badge";
import {
  statusLabelForState,
  statusToneForState,
} from "../components/ui/status-badge.helpers";

export type AgentPickerPhase = "loading" | "ready" | "error" | "binding";

export interface AgentPickerProps {
  agents: CloudCompatAgent[];
  /** The cloud agent id already bound as the active server, if any. */
  activeAgentId: string | null;
  phase: AgentPickerPhase;
  errorMessage: string | null;
  /** The agent id currently being bound (drives the per-row spinner). */
  bindingAgentId: string | null;
  onPick: (agentId: string) => void;
  onCreateNew: () => void;
  onRetry: () => void;
  onBack: () => void;
}

/** Statuses that mean the agent is being torn down — not selectable. */
function isDeletingStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "deletion_pending" || normalized === "deleting";
}

function formatLastActive(agent: CloudCompatAgent): string | null {
  const raw = agent.last_heartbeat_at ?? agent.updated_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return parsed.toLocaleString();
  } catch {
    return parsed.toISOString();
  }
}

/**
 * Presentational agent picker shown on the dark onboarding overlay after cloud
 * sign-in when the user already has cloud agents. All fetch/bind/provision logic
 * lives in the first-run controller — this component only renders props and
 * forwards the user's choice. Visual language mirrors CompactOnboarding's
 * white / white→[#FF5800] pills and rounded-2xl option rows (NOT the light
 * SettingsRow cards, which clash with the overlay).
 */
export function AgentPicker({
  agents,
  activeAgentId,
  phase,
  errorMessage,
  bindingAgentId,
  onPick,
  onCreateNew,
  onRetry,
  onBack,
}: AgentPickerProps): React.ReactElement {
  const binding = phase === "binding";

  return (
    <div
      data-testid="onboarding-agent-picker"
      className="flex w-full flex-col gap-5"
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="text-center text-[20px] font-semibold tracking-[-0.01em]">
          Choose your agent
        </h1>
        <p className="text-center text-[13px] leading-snug text-white/65">
          Pick one of your existing Eliza Cloud agents, or create a new one.
        </p>
      </div>

      {phase === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-8 text-white/70">
          <Loader2
            data-testid="onboarding-agent-loading"
            className="h-5 w-5 animate-spin"
          />
          <span className="text-sm">Finding your agents…</span>
        </div>
      ) : phase === "error" ? (
        <div className="flex w-full flex-col items-center gap-4 py-4">
          <p className="text-center text-sm leading-snug text-white/85">
            {errorMessage ?? "Could not load your agents. Try again."}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="onboarding-agent-back"
              onClick={onBack}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              type="button"
              data-testid="onboarding-agent-retry"
              onClick={onRetry}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-[#FF5800] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)] transition-opacity hover:opacity-90 active:scale-[0.98] motion-reduce:active:scale-100"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex w-full flex-col gap-2.5">
            {agents.map((agent) => {
              const isActive =
                activeAgentId !== null && agent.agent_id === activeAgentId;
              const deleting = isDeletingStatus(agent.status);
              const isBinding = binding && bindingAgentId === agent.agent_id;
              const disabled = binding || deleting || isActive;
              const label = agent.agent_name || agent.agent_id;
              const lastActive = formatLastActive(agent);
              return (
                <button
                  key={agent.agent_id}
                  type="button"
                  data-testid={`onboarding-agent-option-${agent.agent_id}`}
                  disabled={disabled}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onPick(agent.agent_id)}
                  className="group flex w-full items-center gap-3.5 rounded-2xl border border-white/20 bg-white/[0.08] px-4 py-3.5 text-left backdrop-blur-sm transition-colors duration-200 hover:bg-white/[0.14] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:active:scale-100"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.12]">
                    <Bot className="h-5 w-5 text-white/90" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-semibold leading-tight">
                        {label}
                      </span>
                      <StatusBadge
                        tone={statusToneForState(agent.status)}
                        label={
                          deleting
                            ? "Deleting"
                            : statusLabelForState(agent.status)
                        }
                      />
                    </span>
                    {lastActive ? (
                      <span className="truncate text-[12px] text-white/55">
                        Last active {lastActive}
                      </span>
                    ) : null}
                  </span>
                  {isActive ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-white/80">
                      <Check className="h-4 w-4" />
                      Active
                    </span>
                  ) : isBinding ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/70" />
                  ) : (
                    <ArrowRight className="h-4 w-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-1 flex items-center justify-between gap-3">
            <button
              type="button"
              data-testid="onboarding-agent-back"
              disabled={binding}
              onClick={onBack}
              className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              type="button"
              data-testid="onboarding-agent-create"
              disabled={binding}
              onClick={onCreateNew}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-[#FF5800] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50 motion-reduce:active:scale-100"
            >
              {binding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create new
            </button>
          </div>
        </>
      )}
    </div>
  );
}
