/**
 * Node components for React Flow diagrams.
 * Provides node container with handles, header, title, description, and footer components.
 *
 * @param props.handles - Handle configuration (target and source)
 */
import type { ComponentProps } from "react";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../card";
export type NodeProps = ComponentProps<typeof Card> & {
    handles: {
        target: boolean;
        source: boolean;
    };
};
export declare const Node: ({ handles, className, ...props }: NodeProps) => import("react/jsx-runtime").JSX.Element;
export type NodeHeaderProps = ComponentProps<typeof CardHeader>;
export declare const NodeHeader: ({ className, ...props }: NodeHeaderProps) => import("react/jsx-runtime").JSX.Element;
export type NodeTitleProps = ComponentProps<typeof CardTitle>;
export declare const NodeTitle: (props: NodeTitleProps) => import("react/jsx-runtime").JSX.Element;
export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;
export declare const NodeDescription: (props: NodeDescriptionProps) => import("react/jsx-runtime").JSX.Element;
export type NodeActionProps = ComponentProps<typeof CardAction>;
export declare const NodeAction: (props: NodeActionProps) => import("react/jsx-runtime").JSX.Element;
export type NodeContentProps = ComponentProps<typeof CardContent>;
export declare const NodeContent: ({ className, ...props }: NodeContentProps) => import("react/jsx-runtime").JSX.Element;
export type NodeFooterProps = ComponentProps<typeof CardFooter>;
export declare const NodeFooter: ({ className, ...props }: NodeFooterProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=node.d.ts.map