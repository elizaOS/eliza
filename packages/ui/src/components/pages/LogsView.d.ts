import { type ReactNode } from "react";
/**
 * Logs page — formerly split across `LogsPageView` (a 17-LOC ContentLayout
 * wrapper) and `LogsView` (the panel). Folded into one component since
 * neither caller passed contentHeader/inModal — both props default to
 * the same shape the wrapper used to apply.
 */
export declare function LogsView({ contentHeader, inModal, }?: {
    contentHeader?: ReactNode;
    inModal?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=LogsView.d.ts.map