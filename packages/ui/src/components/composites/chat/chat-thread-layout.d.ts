import * as React from "react";
import type { ChatVariant } from "./chat-types";
type RefLike<T> = ((instance: T | null) => void) | {
    current: T | null;
} | null;
export interface ChatThreadLayoutProps extends React.HTMLAttributes<HTMLElement> {
    composerHeight?: number;
    composer?: React.ReactNode;
    footerStack?: React.ReactNode;
    gameModalComposerGapPx?: number;
    gameModalMessageBottomFallback?: string;
    gameModalMessageTop?: string;
    imageDragOver?: boolean;
    messagesClassName?: string;
    messagesRef?: RefLike<HTMLDivElement>;
    messagesStyle?: React.CSSProperties;
    messagesTestId?: string;
    variant?: ChatVariant;
}
export declare const ChatThreadLayout: React.ForwardRefExoticComponent<ChatThreadLayoutProps & React.RefAttributes<HTMLElement>>;
export {};
//# sourceMappingURL=chat-thread-layout.d.ts.map