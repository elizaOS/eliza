export interface ConversationRenameDialogProps {
  open: boolean;
  conversationId: string | null;
  /** Raw API title (not localized). */
  initialTitle: string;
  onClose: () => void;
}
export declare function ConversationRenameDialog({
  open,
  conversationId,
  initialTitle,
  onClose,
}: ConversationRenameDialogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConversationRenameDialog.d.ts.map
