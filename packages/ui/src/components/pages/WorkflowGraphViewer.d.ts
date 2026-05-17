import type { WorkflowDefinition } from "../../api/client-types-chat";

interface WorkflowGraphViewerProps {
  workflow: WorkflowDefinition | null;
  loading?: boolean;
  isGenerating?: boolean;
  emptyStateActionLabel?: string;
  emptyStateHelpText?: string;
  onNodeClick?: (nodeName: string) => void;
  onEmptyStateAction?: () => void;
}
export declare function WorkflowGraphViewer({
  workflow,
  loading,
  isGenerating,
  emptyStateActionLabel,
  emptyStateHelpText,
  onNodeClick,
  onEmptyStateAction,
}: WorkflowGraphViewerProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WorkflowGraphViewer.d.ts.map
