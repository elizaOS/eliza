import type * as React from "react";
import type { ChatVariant } from "./chat-types";
export interface ChatEmptyStateProps {
    action?: React.ReactNode;
    agentName: string;
    className?: string;
    hint?: React.ReactNode;
    labels?: {
        chatIconLabel?: string;
        sendMessageTo?: string;
        startConversation?: string;
        toBeginChatting?: string;
    };
    onSuggestionClick?: (suggestion: string) => void;
    suggestions?: string[];
    variant?: ChatVariant;
}
export declare function ChatEmptyState({ action, agentName, className, hint, labels, onSuggestionClick, suggestions, variant, }: ChatEmptyStateProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-empty-state.d.ts.map