import type { ChatMessageLabels } from "./chat-types";
export interface ChatMessageActionsProps {
    canDelete?: boolean;
    canEdit?: boolean;
    canPlay?: boolean;
    copied?: boolean;
    labels?: ChatMessageLabels;
    onCopy?: () => void;
    onDelete?: () => void;
    onEdit?: () => void;
    onPlay?: () => void;
}
export declare function ChatMessageActions({ canDelete, canEdit, canPlay, copied, labels, onCopy, onDelete, onEdit, onPlay, }: ChatMessageActionsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-message-actions.d.ts.map