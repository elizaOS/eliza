export interface ChatConversationRenameDialogProps {
    cancelLabel?: string;
    description: string;
    inputLabel: string;
    onChange: (value: string) => void;
    onClose: () => void;
    onSave: () => void | Promise<void>;
    onSuggest?: () => void | Promise<void>;
    open: boolean;
    saving?: boolean;
    saveLabel: string;
    saveDisabled?: boolean;
    savePendingLabel?: string;
    suggesting?: boolean;
    suggestDisabled?: boolean;
    suggestLabel?: string;
    suggestPendingLabel?: string;
    title: string;
    value: string;
}
export declare function ChatConversationRenameDialog({ cancelLabel, description, inputLabel, onChange, onClose, onSave, onSuggest, open, saving, saveLabel, savePendingLabel, saveDisabled, suggesting, suggestDisabled, suggestLabel, suggestPendingLabel, title, value, }: ChatConversationRenameDialogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-conversation-rename-dialog.d.ts.map