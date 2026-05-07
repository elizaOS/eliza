/**
 * Toolbar component wrapping React Flow node toolbar with custom styling.
 * Provides toolbar overlay for flow diagram nodes.
 */

import { NodeToolbar, Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn("flex items-center gap-1 rounded-sm border bg-background p-1.5", className)}
    position={Position.Bottom}
    {...props}
  />
);
