import * as React from "react";
import type { ShellMessage } from "./shell-state";
export interface ChatSurfaceProps {
    messages: readonly ShellMessage[];
    onSend: (text: string) => void;
    canSend: boolean;
    greeting?: string;
}
/**
 * Chat surface: scrollable bubble stack + input row.
 *
 * v1: text-only. The mic button is rendered as a disabled placeholder so the
 * layout matches the mockups; the listening/STT flow ships in the mic
 * follow-up sub-project.
 */
export declare function ChatSurface({ messages, onSend, canSend, greeting, }: ChatSurfaceProps): React.JSX.Element;
//# sourceMappingURL=ChatSurface.d.ts.map