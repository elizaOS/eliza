/**
 * TrajectoryPipelineGraph — horizontal pipeline visualization showing
 * agent processing stages: input → shouldRespond → plan → actions → evaluators.
 *
 * Pure presentational component. The parent owns filter state and passes
 * pre-computed node data.
 */

import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PipelineStageId =
  | "input"
  | "should_respond"
  | "plan"
  | "actions"
  | "evaluators";

export interface PipelineNode {
  id: PipelineStageId;
  label: string;
  callCount: number;
  status: "active" | "skipped" | "error";
  icon: LucideIcon;
}

export interface TrajectoryPipelineGraphProps {
  /** Ordered array of pipeline nodes (typically 5). */
  nodes: PipelineNode[];
  /** Currently selected stage, or null for "show all". */
  activeStageId: PipelineStageId | null;
  /** Callback when a stage node is clicked. */
  onStageClick: (stageId: PipelineStageId) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PipelineConnector({ dimmed }: { dimmed?: boolean }) {
  return (
    <div
      className={`flex items-center ${dimmed ? "opacity-30" : "opacity-60"}`}
    >
      <svg
        width="36"
        height="12"
        viewBox="0 0 36 12"
        fill="none"
        className="shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1="0"
          y1="6"
          x2="28"
          y2="6"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-muted"
        />
        <path
          d="M28 2 L34 6 L28 10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          className="text-muted"
        />
      </svg>
    </div>
  );
}

function PipelineNodeButton({
  node,
  selected,
  onClick,
}: {
  node: PipelineNode;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = node.icon;

  const statusClasses = {
    active: selected
      ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 shadow-sm"
      : "border-border/40 hover:border-border/60 hover:shadow-sm",
    skipped: selected
      ? "border-primary/30 bg-primary/5 ring-2 ring-primary/20 opacity-70"
      : "border-border/25 border-dashed opacity-50 hover:opacity-70",
    error: selected
      ? "border-danger/40 bg-danger/5 ring-2 ring-danger/30"
      : "border-danger/30 hover:border-danger/40",
  };

  const iconColor = {
    active: selected ? "text-primary" : "text-txt/70",
    skipped: "text-muted/50",
    error: "text-danger/80",
  };

  const countBg = {
    active: selected ? "bg-primary/15 text-primary" : "bg-muted/10 text-txt/60",
    skipped: "bg-muted/8 text-muted/40",
    error: "bg-danger/10 text-danger/70",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex min-w-[90px] flex-col items-center gap-1.5 rounded-xl border
        px-3 py-2.5 transition-all duration-150 cursor-pointer select-none
        ${statusClasses[node.status]}
      `}
    >
      <Icon className={`h-5 w-5 ${iconColor[node.status]}`} />
      <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-txt/70 whitespace-nowrap">
        {node.label}
      </span>
      <span
        className={`
          rounded-full px-2 py-0.5 text-2xs font-bold leading-none
          ${countBg[node.status]}
        `}
      >
        {node.id === "input" ? "\u2713" : node.callCount}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TrajectoryPipelineGraph({
  nodes,
  activeStageId,
  onStageClick,
}: TrajectoryPipelineGraphProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {nodes.map((node, i) => (
        <div key={node.id} className="contents">
          {i > 0 && (
            <PipelineConnector
              dimmed={
                node.status === "skipped" ||
                (i > 0 && nodes[i - 1].status === "skipped")
              }
            />
          )}
          <PipelineNodeButton
            node={node}
            selected={activeStageId === node.id}
            onClick={() => onStageClick(node.id)}
          />
        </div>
      ))}
    </div>
  );
}
