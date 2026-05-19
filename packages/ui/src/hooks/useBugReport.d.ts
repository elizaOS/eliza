import { type ReactNode } from "react";
export interface BugReportDraft {
    description?: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    environment?: string;
    nodeVersion?: string;
    modelProvider?: string;
    logs?: string;
}
interface BugReportContextValue {
    isOpen: boolean;
    draft: BugReportDraft | null;
    open: (draft?: BugReportDraft) => void;
    close: () => void;
}
export declare function useOptionalBugReport(): BugReportContextValue | null;
export declare function useBugReport(): BugReportContextValue;
export declare function useBugReportState(): BugReportContextValue;
export declare function BugReportProvider({ children, value, }: {
    children: ReactNode;
    value: BugReportContextValue;
}): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=useBugReport.d.ts.map