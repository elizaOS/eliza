/**
 * Tool component for displaying AI tool usage in a collapsible format.
 * Shows tool status, input/output, and execution results with status badges.
 */
import type { ToolUIPart } from "ai";
import type { ComponentProps } from "react";
import { Collapsible, CollapsibleContent } from "../collapsible";
export type ToolProps = ComponentProps<typeof Collapsible>;
export declare const Tool: ({ className, ...props }: ToolProps) => import("react/jsx-runtime").JSX.Element;
export type ToolHeaderProps = {
    title?: string;
    type: ToolUIPart["type"];
    state: ToolUIPart["state"];
    className?: string;
};
export declare const ToolHeader: ({ className, title, type, state, ...props }: ToolHeaderProps) => import("react/jsx-runtime").JSX.Element;
export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;
export declare const ToolContent: ({ className, ...props }: ToolContentProps) => import("react/jsx-runtime").JSX.Element;
export type ToolInputProps = ComponentProps<"div"> & {
    input: ToolUIPart["input"];
};
export declare const ToolInput: ({ className, input, ...props }: ToolInputProps) => import("react/jsx-runtime").JSX.Element;
export type ToolOutputProps = ComponentProps<"div"> & {
    output: ToolUIPart["output"];
    errorText: ToolUIPart["errorText"];
};
export declare const ToolOutput: ({ className, output, errorText, ...props }: ToolOutputProps) => import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=tool.d.ts.map