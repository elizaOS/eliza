/**
 * Conversation component for displaying chat messages with auto-scroll to bottom.
 * Uses StickToBottom for smooth scrolling behavior and provides empty state support.
 */
import type { ComponentProps } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { Button } from "../button";
export type ConversationProps = ComponentProps<typeof StickToBottom>;
export declare const Conversation: ({ className, ...props }: ConversationProps) => import("react/jsx-runtime").JSX.Element;
export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;
export declare const ConversationContent: ({ className, ...props }: ConversationContentProps) => import("react/jsx-runtime").JSX.Element;
export type ConversationEmptyStateProps = ComponentProps<"div"> & {
    title?: string;
    description?: string;
    icon?: React.ReactNode;
};
export declare const ConversationEmptyState: ({ className, title, description, icon, children, ...props }: ConversationEmptyStateProps) => import("react/jsx-runtime").JSX.Element;
export type ConversationScrollButtonProps = ComponentProps<typeof Button>;
export declare const ConversationScrollButton: ({ className, ...props }: ConversationScrollButtonProps) => false | import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=conversation.d.ts.map