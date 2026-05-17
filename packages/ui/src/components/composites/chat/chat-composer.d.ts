import { type KeyboardEvent, type RefObject } from "react";
import type { VoiceSessionMode } from "../../../voice/voice-chat-types";
import type { ChatVariant } from "./chat-types";
export interface ChatComposerVoiceState {
    assistantTtsQuality?: "enhanced" | "standard";
    captureMode: VoiceSessionMode;
    interimTranscript: string;
    isListening: boolean;
    isSpeaking: boolean;
    startListening: (mode?: Exclude<VoiceSessionMode, "idle">) => void | Promise<void>;
    stopListening: (options?: {
        submit?: boolean;
    }) => void | Promise<void>;
    supported: boolean;
    toggleListening: () => void;
}
export interface ChatComposerProps {
    agentVoiceEnabled: boolean;
    chatInput: string;
    chatPendingImagesCount: number;
    chatSending: boolean;
    isAgentStarting: boolean;
    isComposerLocked: boolean;
    layout?: "default" | "inline";
    onAttachImage: () => void;
    onChatInputChange: (value: string) => void;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onSend: () => void;
    onStop: () => void;
    onStopSpeaking: () => void;
    onToggleAgentVoice: () => void;
    showAgentVoiceToggle?: boolean;
    t: (key: string, options?: Record<string, unknown>) => string;
    textareaAriaLabel?: string;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    variant: ChatVariant;
    voice: ChatComposerVoiceState;
    codingAgentsAvailable?: boolean;
    onCreateTask?: (description: string, agentType: string) => void;
    /** Hide the attach-image button (used where outbound attachments aren't supported). */
    hideAttachButton?: boolean;
    /** Placeholder override for the textarea. */
    placeholder?: string;
}
export declare function ChatComposer({ variant, layout, textareaRef, chatInput, chatPendingImagesCount, isComposerLocked, isAgentStarting, chatSending, voice, agentVoiceEnabled, showAgentVoiceToggle, t, onAttachImage, onChatInputChange, onKeyDown, onSend, onStop, onStopSpeaking, onToggleAgentVoice, codingAgentsAvailable, onCreateTask, hideAttachButton, placeholder, textareaAriaLabel, }: ChatComposerProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-composer.d.ts.map