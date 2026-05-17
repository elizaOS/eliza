/**
 * Chain of thought component displaying AI reasoning steps in a collapsible format.
 * Supports controlled and uncontrolled open states with step indicators.
 *
 * @param props.open - Controlled open state
 * @param props.defaultOpen - Default open state (uncontrolled)
 * @param props.onOpenChange - Callback when open state changes
 */
import { type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "../badge";
import { CollapsibleContent, CollapsibleTrigger } from "../collapsible";
export type ChainOfThoughtProps = ComponentProps<"div"> & {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
};
export declare const ChainOfThought: import("react").MemoExoticComponent<({ className, open, defaultOpen, onOpenChange, children, ...props }: ChainOfThoughtProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger>;
export declare const ChainOfThoughtHeader: import("react").MemoExoticComponent<({ className, children, ...props }: ChainOfThoughtHeaderProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
    icon?: LucideIcon;
    label: string;
    description?: string;
    status?: "complete" | "active" | "pending";
};
export declare const ChainOfThoughtStep: import("react").MemoExoticComponent<({ className, icon: Icon, label, description, status, children, ...props }: ChainOfThoughtStepProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;
export declare const ChainOfThoughtSearchResults: import("react").MemoExoticComponent<({ className, ...props }: ChainOfThoughtSearchResultsProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;
export declare const ChainOfThoughtSearchResult: import("react").MemoExoticComponent<({ className, children, ...props }: ChainOfThoughtSearchResultProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>;
export declare const ChainOfThoughtContent: import("react").MemoExoticComponent<({ className, children, ...props }: ChainOfThoughtContentProps) => import("react/jsx-runtime").JSX.Element>;
export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
    caption?: string;
};
export declare const ChainOfThoughtImage: import("react").MemoExoticComponent<({ className, children, caption, ...props }: ChainOfThoughtImageProps) => import("react/jsx-runtime").JSX.Element>;
//# sourceMappingURL=chain-of-thought.d.ts.map