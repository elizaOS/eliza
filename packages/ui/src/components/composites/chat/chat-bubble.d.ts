import type * as React from "react";
export type ChatBubbleTone = "assistant" | "user";
export interface ChatBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
    tone?: ChatBubbleTone;
    /**
     * Source channel the message came from (e.g. "imessage", "telegram",
     * "discord", "whatsapp"). When set, the bubble renders a connector-
     * colored outline so cross-channel messages stay visually distinct
     * without adding a repeated text badge above every message.
     */
    source?: string;
}
export declare function ChatBubble({ tone, source, className, ...props }: ChatBubbleProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=chat-bubble.d.ts.map