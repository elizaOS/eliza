/**
 * TrajectoryPipelineGraph — horizontal pipeline visualization showing
 * agent processing stages: input → shouldRespond → plan → actions → evaluators.
 *
 * Pure presentational component. The parent owns filter state and passes
 * pre-computed node data.
 */

import type { LucideIcon } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";

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
        width="24"
        height="12"
        viewBox="0 0 24 12"
        fill="none"
        className="shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1="0"
          y1="6"
          x2="17"
          y2="6"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-muted"
        />
        <path
          d="M17 2 L23 6 L17 10"
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

  const iconColor = {
    active: selected
      ? "text-[color:var(--settings-foreground)]"
      : "text-[color:var(--settings-muted)]",
    skipped: "text-[color:var(--settings-muted)] opacity-50",
    error: "text-danger/80",
  };

  const countTone = {
    active: selected ? ("accent" as const) : ("muted" as const),
    skipped: "muted" as const,
    error: "danger" as const,
  };

  return (
    <Button
      variant="choice"
      size="card"
      data-state={selected ? "on" : "off"}
      onClick={onClick}
      className="min-w-[6.5rem] items-center"
    >
      <Icon className={`size-5 ${iconColor[node.status]}`} />
      <span className="whitespace-nowrap text-xs font-medium">
        {node.label}
      </span>
      <Badge
        asChild
        variant="secondary"
        size="compact"
        tone={countTone[node.status]}
        className="px-2 py-0.5 text-xs font-medium normal-case leading-none"
      >
        <span>{node.id === "input" ? "Ready" : `${node.callCount} calls`}</span>
      </Badge>
    </Button>
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
    <div className="flex items-center overflow-x-auto py-1">
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
