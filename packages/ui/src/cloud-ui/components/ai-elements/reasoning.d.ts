import type { ComponentProps } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
/**
 * Collapsible reasoning display component showing AI thinking process.
 * Auto-closes after streaming completes and displays duration.
 *
 * @param props.isStreaming - Whether reasoning is currently streaming
 * @param props.open - Controlled open state
 * @param props.defaultOpen - Default open state (uncontrolled)
 * @param props.onOpenChange - Callback when open state changes
 * @param props.duration - Reasoning duration in milliseconds
 */
export type ReasoningProps = ComponentProps<typeof Collapsible> & {
    isStreaming?: boolean;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    duration?: number;
};
export declare const Reasoning: import("react").MemoExoticComponent<({ className, isStreaming, open, defaultOpen, onOpenChange, duration: durationProp, children, ...props }: ReasoningProps) => import("react/jsx-runtime").JSX.Element>;
export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;
export declare const ReasoningTrigger: import("react").MemoExoticComponent<({ className, children, ...props }: ReasoningTriggerProps) => import("react/jsx-runtime").JSX.Element>;
export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
    children: string;
};
export declare const ReasoningContent: import("react").MemoExoticComponent<({ className, children, ...props }: ReasoningContentProps) => import("react/jsx-runtime").JSX.Element>;
//# sourceMappingURL=reasoning.d.ts.map