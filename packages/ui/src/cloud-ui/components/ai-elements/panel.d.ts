/**
 * Panel component wrapping React Flow panel primitive with custom styling.
 * Used for overlay panels in flow diagrams.
 */
import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

type PanelProps = ComponentProps<typeof PanelPrimitive>;
export declare const Panel: ({
  className,
  ...props
}: PanelProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=panel.d.ts.map
