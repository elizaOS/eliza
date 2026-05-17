/**
 * TrajectoryPipelineGraph — horizontal pipeline visualization showing
 * agent processing stages: input → shouldRespond → plan → actions → evaluators.
 *
 * Pure presentational component. The parent owns filter state and passes
 * pre-computed node data.
 */
import type { LucideIcon } from "lucide-react";
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
export declare function TrajectoryPipelineGraph({
  nodes,
  activeStageId,
  onStageClick,
}: TrajectoryPipelineGraphProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-pipeline-graph.d.ts.map
