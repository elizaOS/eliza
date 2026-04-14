import type * as React from "react";

import type { EmptyStateProps } from "../../ui/empty-state";

export type PanelElement = "div" | "section";

export type PagePanelVariant =
  | "surface"
  | "section"
  | "padded"
  | "inset"
  | "shell"
  | "workspace";

export type PagePanelProps = {
  as?: PanelElement;
  variant?: PagePanelVariant;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "as" | "className">;

export interface MetaPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  compact?: boolean;
  tone?: "default" | "accent" | "strong";
}

export interface PanelHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: React.ReactNode;
  eyebrowClassName?: string;
  heading: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  media?: React.ReactNode;
  bordered?: boolean;
  contentClassName?: string;
  headingClassName?: string;
  descriptionClassName?: string;
}

export interface SummaryCardProps extends React.HTMLAttributes<HTMLDivElement> {
  compact?: boolean;
}

export interface PageActionRailProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface PanelNoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "accent" | "warning" | "danger";
  actions?: React.ReactNode;
}

export interface PageEmptyStateProps extends EmptyStateProps {
  variant?: "panel" | "inset" | "surface" | "workspace";
}

export interface PageLoadingStateProps
  extends React.HTMLAttributes<HTMLDivElement> {
  heading: React.ReactNode;
  description?: React.ReactNode;
  variant?: "panel" | "surface" | "workspace";
}

export interface PagePanelFrameProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface PagePanelContentAreaProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface PagePanelToolbarProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface PagePanelCollapsibleSectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  as?: PanelElement;
  actions?: React.ReactNode;
  bordered?: boolean;
  bodyClassName?: string;
  defaultExpanded?: boolean;
  description?: React.ReactNode;
  descriptionClassName?: string;
  expanded?: boolean;
  expandOnCollapsedSurfaceClick?: boolean;
  heading: React.ReactNode;
  headingClassName?: string;
  headerContentClassName?: string;
  media?: React.ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  variant?: Extract<PagePanelVariant, "section" | "surface" | "inset">;
}
