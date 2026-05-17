import * as React from "react";
export interface TrajectoryCodeBlockProps {
    collapseLabel: React.ReactNode;
    content: string;
    copyLabel: React.ReactNode;
    copyToClipboardLabel?: string;
    expandLabel: React.ReactNode;
    label: React.ReactNode;
    linesLabel: React.ReactNode;
    onCopy: (content: string) => void;
}
export declare function TrajectoryCodeBlock({ collapseLabel, content, copyLabel, copyToClipboardLabel, expandLabel, label, linesLabel, onCopy, }: TrajectoryCodeBlockProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-code-block.d.ts.map