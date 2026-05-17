/**
 * Task component for displaying task items in a collapsible format.
 * Supports task items with file attachments and collapsible task lists.
 */
import type { ComponentProps } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
export type TaskItemFileProps = ComponentProps<"div">;
export declare const TaskItemFile: ({ children, className, ...props }: TaskItemFileProps) => import("react/jsx-runtime").JSX.Element;
export type TaskItemProps = ComponentProps<"div">;
export declare const TaskItem: ({ children, className, ...props }: TaskItemProps) => import("react/jsx-runtime").JSX.Element;
export type TaskProps = ComponentProps<typeof Collapsible>;
export declare const Task: ({ defaultOpen, className, ...props }: TaskProps) => import("react/jsx-runtime").JSX.Element;
export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
    title: string;
};
export declare const TaskTrigger: ({ children, className, title, ...props }: TaskTriggerProps) => import("react/jsx-runtime").JSX.Element;
export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;
export declare const TaskContent: ({ children, className, ...props }: TaskContentProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=task.d.ts.map