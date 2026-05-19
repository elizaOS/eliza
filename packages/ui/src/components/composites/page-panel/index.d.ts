import { PageEmptyState } from "./page-panel-empty";
import { PagePanelFeatureEmpty } from "./page-panel-feature-empty";
import { MetaPill, PageActionRail, PanelHeader, PanelNotice, SummaryCard } from "./page-panel-header";
import { PageLoadingState } from "./page-panel-loading";
export * from "./page-panel-collapsible-section";
export * from "./page-panel-empty";
export * from "./page-panel-feature-empty";
export * from "./page-panel-frame";
export * from "./page-panel-header";
export * from "./page-panel-loading";
export * from "./page-panel-root";
export * from "./page-panel-toolbar";
export * from "./page-panel-types";
export declare const PagePanel: import("react").ForwardRefExoticComponent<{
    as?: import("./page-panel-types").PanelElement;
    variant?: import("./page-panel-types").PagePanelVariant;
    className?: string;
} & Omit<Omit<import("react").DetailedHTMLProps<import("react").HTMLAttributes<HTMLDivElement>, HTMLDivElement>, "ref">, "as" | "className"> & import("react").RefAttributes<HTMLDivElement>> & {
    CollapsibleSection: import("react").ForwardRefExoticComponent<import("./page-panel-types").PagePanelCollapsibleSectionProps & import("react").RefAttributes<HTMLElement>>;
    ContentArea: import("react").ForwardRefExoticComponent<import("./page-panel-types").PagePanelContentAreaProps & import("react").RefAttributes<HTMLDivElement>>;
    Header: typeof PanelHeader;
    Frame: import("react").ForwardRefExoticComponent<import("./page-panel-types").PagePanelFrameProps & import("react").RefAttributes<HTMLDivElement>>;
    Meta: typeof MetaPill;
    Notice: typeof PanelNotice;
    SummaryCard: typeof SummaryCard;
    Empty: typeof PageEmptyState;
    FeatureEmpty: typeof PagePanelFeatureEmpty;
    Loading: typeof PageLoadingState;
    ActionRail: typeof PageActionRail;
    Toolbar: import("react").ForwardRefExoticComponent<import("./page-panel-types").PagePanelToolbarProps & import("react").RefAttributes<HTMLDivElement>>;
};
//# sourceMappingURL=index.d.ts.map