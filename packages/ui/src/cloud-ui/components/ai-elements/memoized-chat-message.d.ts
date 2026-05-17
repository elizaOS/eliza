/**
 * Memoized chat message component for performance optimization.
 * Prevents re-renders of messages that haven't changed.
 */
import { type ChatMediaAttachment } from "../../types/chat-media";
export interface MemoizedChatMessageMessage {
    id: string;
    content: {
        text: string;
        clientMessageId?: string;
        attachments?: ChatMediaAttachment[];
    };
    isAgent: boolean;
    createdAt: number;
}
export interface MemoizedChatMessageProps {
    message: MemoizedChatMessageMessage;
    characterName: string;
    characterAvatarUrl?: string;
    copiedMessageId: string | null;
    currentPlayingId: string | null;
    isPlaying: boolean;
    hasAudioUrl: boolean;
    isStreaming?: boolean;
    formatTimestamp: (timestamp: number) => string;
    onCopy: (text: string, messageId: string, attachments?: MemoizedChatMessageMessage["content"]["attachments"]) => void;
    onPlayAudio?: (messageId: string) => void;
    onImageLoad?: () => void;
    /** Chain-of-thought reasoning text to display while thinking */
    reasoningText?: string;
    /** Current phase of reasoning: planning, actions, or response */
    reasoningPhase?: "planning" | "actions" | "response" | null;
    /** Callback when typewriter animation reveals more text (for scrolling) */
    onTextReveal?: () => void;
}
declare function ChatMessageComponent(props: MemoizedChatMessageProps): import("react/jsx-runtime").JSX.Element;
export declare const MemoizedChatMessage: import("react").MemoExoticComponent<typeof ChatMessageComponent>;
export {};
//# sourceMappingURL=memoized-chat-message.d.ts.map