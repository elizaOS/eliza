/** Assembles the compound page surface from its owned components. */

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
