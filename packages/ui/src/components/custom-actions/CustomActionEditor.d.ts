import type { CustomActionDef } from "@elizaos/shared";

interface CustomActionEditorProps {
  open: boolean;
  action?: CustomActionDef | null;
  onSave: (action: CustomActionDef) => void;
  onClose: () => void;
}
export declare function CustomActionEditor({
  open,
  action,
  onSave,
  onClose,
}: CustomActionEditorProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=CustomActionEditor.d.ts.map
