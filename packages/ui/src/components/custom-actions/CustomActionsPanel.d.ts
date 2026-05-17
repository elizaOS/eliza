import type { CustomActionDef } from "@elizaos/shared";

interface CustomActionsPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenEditor: (action?: CustomActionDef | null) => void;
}
export declare function CustomActionsPanel({
  open,
  onClose,
  onOpenEditor,
}: CustomActionsPanelProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CustomActionsPanel.d.ts.map
