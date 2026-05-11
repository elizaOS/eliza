import { Loader2 } from "lucide-react";
import { useTrainingBudget } from "./hooks/useTrainingApi";
import type { TrainingBudget } from "./types";

interface BudgetPanelProps {
  jobId: string;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function BudgetGauge({ budget }: { budget: TrainingBudget }) {
  // Compute the bar fill percentage as a fraction of the hard cap (1.5×
  // soft). When no cap is configured we anchor against $50 just so the
  // bar has a sensible visible domain — the gauge is informational only
  // in the unbounded case.
  const cap =
    budget.hard_cap_usd ?? Math.max(50, budget.total_so_far_usd * 1.5);
  const fraction = Math.min(1, budget.total_so_far_usd / cap);
  const pct = fraction * 100;

  let barColor = "bg-green-500";
  if (budget.over_hard) {
    barColor = "bg-red-500";
  } else if (budget.over_soft) {
    barColor = "bg-amber-500";
  } else if (budget.soft_cap_usd !== null && fraction > 0.66) {
    barColor = "bg-amber-400";
  }

  return (
    <div className="space-y-1">
      <div className="h-2 w-full bg-card border border-border rounded overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{formatUsd(0)}</span>
        {budget.soft_cap_usd !== null && (
          <span>soft {formatUsd(budget.soft_cap_usd)}</span>
        )}
        {budget.hard_cap_usd !== null && (
          <span>hard {formatUsd(budget.hard_cap_usd)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Running-cost panel for a Vast.ai training job (M9).
 *
 * Renders the live `dph_total × uptime` snapshot plus the soft / hard
 * budget caps from `MILADY_VAST_MAX_USD`. The hard cap is enforced by
 * the watcher (auto-teardown) — this panel only displays state, it
 * does not call any destructive endpoint.
 */
export function BudgetPanel({ jobId }: BudgetPanelProps) {
  const { data: budget, loading, error } = useTrainingBudget(jobId);

  if (loading && !budget) {
    return (
      <div className="border border-border rounded p-3 bg-card flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="text-xs text-muted">Loading running cost...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-border rounded p-3 bg-red-500/10">
        <div className="text-xs text-red-500">Budget unavailable: {error}</div>
      </div>
    );
  }

  if (!budget) {
    return (
      <div className="border border-border rounded p-3 bg-card">
        <div className="text-xs text-muted">
          No Vast instance provisioned yet — running cost will appear once the
          instance is up.
        </div>
      </div>
    );
  }

  const stateClass = budget.over_hard
    ? "text-red-500"
    : budget.over_soft
      ? "text-amber-500"
      : "text-green-500";

  return (
    <div className="border border-border rounded p-3 bg-card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted uppercase tracking-wide">
            Running Cost
          </div>
          <div className="text-lg font-semibold text-txt-strong font-mono">
            {formatUsd(budget.total_so_far_usd)}
          </div>
          <div className="text-[11px] text-muted">
            {formatUsd(budget.dph_total)}/hr × {budget.uptime_pretty}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted uppercase tracking-wide">
            Pipeline
          </div>
          <div className="text-xs font-mono text-txt">{budget.pipeline}</div>
          <div className="text-[11px] text-muted">{budget.gpu_sku}</div>
        </div>
      </div>

      <BudgetGauge budget={budget} />

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-muted">Soft cap</div>
          <div className="text-txt font-mono">
            {budget.soft_cap_usd !== null
              ? formatUsd(budget.soft_cap_usd)
              : "unset"}
          </div>
        </div>
        <div>
          <div className="text-muted">Hard cap (auto-teardown)</div>
          <div className="text-txt font-mono">
            {budget.hard_cap_usd !== null
              ? formatUsd(budget.hard_cap_usd)
              : "unset"}
          </div>
        </div>
      </div>

      <div className={`text-[11px] font-semibold ${stateClass}`}>
        {budget.over_hard
          ? "OVER HARD CAP — auto-teardown initiated"
          : budget.over_soft
            ? "OVER SOFT CAP — warning"
            : budget.soft_cap_usd !== null
              ? "Within budget"
              : "Enforcement disabled (set MILADY_VAST_MAX_USD)"}
      </div>
    </div>
  );
}
