/**
 * Barrel for the page-panel surface. Re-exports every sub-part and assembles
 * the compound `PagePanel` (Root + Header/Frame/ContentArea/Empty/Loading/…)
 * that view pages use as their standard content chrome.
 */

import { ContentState } from "./content-state";
import { PagePanelCollapsibleSection } from "./page-panel-collapsible-section";
import { PageEmptyState } from "./page-panel-empty";
import { PagePanelFeatureEmpty } from "./page-panel-feature-empty";
import {
  PagePanelContentArea,
  PagePanelContentRail,
  PagePanelFrame,
} from "./page-panel-frame";
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

export * from "./content-state";
export * from "./page-panel-collapsible-section";
export * from "./page-panel-empty";
export * from "./page-panel-feature-empty";
export * from "./page-panel-frame";
export * from "./page-panel-header";
export * from "./page-panel-loading";
export * from "./page-panel-root";
export * from "./page-panel-toolbar";
export * from "./page-panel-types";

export const PagePanel = Object.assign(PagePanelRoot, {
  CollapsibleSection: PagePanelCollapsibleSection,
  ContentState,
  ContentArea: PagePanelContentArea,
  ContentRail: PagePanelContentRail,
  Header: PanelHeader,
  Frame: PagePanelFrame,
  Meta: MetaPill,
  Notice: PanelNotice,
  SummaryCard,
  Empty: PageEmptyState,
  FeatureEmpty: PagePanelFeatureEmpty,
  Loading: PageLoadingState,
  ActionRail: PageActionRail,
  Toolbar: PagePanelToolbar,
});
