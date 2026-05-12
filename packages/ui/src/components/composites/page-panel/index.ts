import { PagePanelCollapsibleSection } from "./page-panel-collapsible-section";
import { PageEmptyState } from "./page-panel-empty";
import { PagePanelContentArea, PagePanelFrame } from "./page-panel-frame";
import {
  MetaPill,
  PageActionRail,
  PanelHeader,
  PanelNotice,
  SummaryCard,
} from "./page-panel-header";
import { PageLoadingState } from "./page-panel-loading";
import { PagePanelRoot } from "./page-panel-root";
import { PagePanelToolbar } from "./page-panel-toolbar";

export * from "./page-panel-collapsible-section";
export * from "./page-panel-empty";
export * from "./page-panel-frame";
export * from "./page-panel-header";
export * from "./page-panel-loading";
export * from "./page-panel-root";
export * from "./page-panel-toolbar";
export * from "./page-panel-types";

export const PagePanel = Object.assign(PagePanelRoot, {
  CollapsibleSection: PagePanelCollapsibleSection,
  ContentArea: PagePanelContentArea,
  Header: PanelHeader,
  Frame: PagePanelFrame,
  Meta: MetaPill,
  Notice: PanelNotice,
  SummaryCard,
  Empty: PageEmptyState,
  Loading: PageLoadingState,
  ActionRail: PageActionRail,
  Toolbar: PagePanelToolbar,
});
