/** Assembles the compound page surface from its owned components. */

import {
  ContentState,
  PageEmptyState,
  PageLoadingState,
} from "./content-state";
import { PagePanelCollapsibleSection } from "./page-panel-collapsible-section";
import { PagePanelFeatureEmpty } from "./page-panel-feature-empty";
import {
  MetaPill,
  PageActionRail,
  PanelHeader,
  PanelNotice,
  SummaryCard,
} from "./page-panel-header";
import {
  PagePanelContentArea,
  PagePanelContentRail,
  PagePanelFrame,
  PagePanelRoot,
  PagePanelToolbar,
} from "./page-panel-layout";

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
