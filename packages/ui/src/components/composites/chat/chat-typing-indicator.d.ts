import type { ChatVariant } from "./chat-types";
export interface TypingIndicatorProps {
    agentAvatarSrc?: string | null;
    agentName: string;
    className?: string;
    dotClassName?: string;
    variant?: ChatVariant;
}
export declare function TypingIndicator({ agentName, className, dotClassName, variant, }: TypingIndicatorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-typing-indicator.d.ts.map