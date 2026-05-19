import type * as React from "react";
import type { ChatVariant } from "./chat-types";
type RefLike<T> = ((instance: T | null) => void) | {
    current: T | null;
} | null;
export interface ChatComposerShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
    before?: React.ReactNode;
    children: React.ReactNode;
    shellRef?: RefLike<HTMLDivElement>;
    variant?: ChatVariant;
}
export declare function ChatComposerShell({ before, children, className, shellRef, style, variant, ...props }: ChatComposerShellProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=chat-composer-shell.d.ts.map