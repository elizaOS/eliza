/**
 * Resizable panel components for creating resizable split-pane layouts.
 * Supports horizontal and vertical directions with configurable panel sizes.
 */
import * as React from "react";
interface ResizablePanelGroupProps extends React.HTMLAttributes<HTMLDivElement> {
    direction?: "horizontal" | "vertical";
}
interface ResizablePanelProps extends React.HTMLAttributes<HTMLDivElement> {
    defaultSize?: number;
    minSize?: number;
    maxSize?: number;
}
interface ResizableHandleProps extends React.HTMLAttributes<HTMLDivElement> {
    withHandle?: boolean;
}
export declare function ResizablePanelGroup({ direction, className, children, ...props }: ResizablePanelGroupProps): import("react/jsx-runtime").JSX.Element;
export declare function ResizablePanel({ defaultSize, minSize, maxSize, className, children, style, ...props }: ResizablePanelProps): import("react/jsx-runtime").JSX.Element;
export declare function ResizableHandle({ withHandle, className, ...props }: ResizableHandleProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=resizable.d.ts.map