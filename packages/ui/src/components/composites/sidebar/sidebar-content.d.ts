import * as React from "react";
export interface SidebarSectionLabelProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SidebarSectionLabel({
  className,
  ...props
}: SidebarSectionLabelProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarSectionHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  meta?: React.ReactNode;
}
export declare function SidebarSectionHeader({
  className,
  meta,
  children,
  ...props
}: SidebarSectionHeaderProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarEmptyStateProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "game-modal";
}
export declare function SidebarEmptyState({
  variant,
  className,
  ...props
}: SidebarEmptyStateProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarNoticeProps
  extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "danger";
  icon?: React.ReactNode;
}
export declare function SidebarNotice({
  tone,
  icon,
  className,
  children,
  ...props
}: SidebarNoticeProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarToolbarProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SidebarToolbar({
  className,
  ...props
}: SidebarToolbarProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarToolbarPrimaryProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SidebarToolbarPrimary({
  className,
  ...props
}: SidebarToolbarPrimaryProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarToolbarActionsProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SidebarToolbarActions({
  className,
  ...props
}: SidebarToolbarActionsProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarItemProps extends React.HTMLAttributes<HTMLElement> {
  active?: boolean;
  as?: "button" | "div";
  variant?: "default" | "accent-soft" | "dashed";
}
export declare const SidebarItem: React.ForwardRefExoticComponent<
  SidebarItemProps & React.RefAttributes<HTMLElement>
>;
export interface SidebarItemIconProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
}
export declare function SidebarItemIcon({
  active,
  className,
  ...props
}: SidebarItemIconProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarItemBodyProps
  extends React.HTMLAttributes<HTMLSpanElement> {}
export declare function SidebarItemBody({
  className,
  ...props
}: SidebarItemBodyProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarItemButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}
export declare const SidebarItemButton: React.ForwardRefExoticComponent<
  SidebarItemButtonProps & React.RefAttributes<HTMLButtonElement>
>;
export interface SidebarItemTitleProps
  extends React.HTMLAttributes<HTMLSpanElement> {}
export declare function SidebarItemTitle({
  className,
  ...props
}: SidebarItemTitleProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarItemDescriptionProps
  extends React.HTMLAttributes<HTMLSpanElement> {}
export declare function SidebarItemDescription({
  className,
  ...props
}: SidebarItemDescriptionProps): import("react/jsx-runtime").JSX.Element;
export interface SidebarRailItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  indicatorTone?: "accent" | "muted";
}
export interface SidebarRailMediaProps
  extends React.HTMLAttributes<HTMLSpanElement> {}
export declare function SidebarRailMedia({
  className,
  ...props
}: SidebarRailMediaProps): import("react/jsx-runtime").JSX.Element;
export declare const SidebarRailItem: React.ForwardRefExoticComponent<
  SidebarRailItemProps & React.RefAttributes<HTMLButtonElement>
>;
export interface SidebarItemActionProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}
export declare function SidebarItemAction({
  className,
  ...props
}: SidebarItemActionProps): import("react/jsx-runtime").JSX.Element;
export declare const SidebarContent: {
  EmptyState: typeof SidebarEmptyState;
  ItemBody: typeof SidebarItemBody;
  ItemDescription: typeof SidebarItemDescription;
  ItemIcon: typeof SidebarItemIcon;
  ItemAction: typeof SidebarItemAction;
  ItemButton: React.ForwardRefExoticComponent<
    SidebarItemButtonProps & React.RefAttributes<HTMLButtonElement>
  >;
  ItemTitle: typeof SidebarItemTitle;
  Toolbar: typeof SidebarToolbar;
  ToolbarPrimary: typeof SidebarToolbarPrimary;
  ToolbarActions: typeof SidebarToolbarActions;
  SectionLabel: typeof SidebarSectionLabel;
  SectionHeader: typeof SidebarSectionHeader;
  Notice: typeof SidebarNotice;
  Item: React.ForwardRefExoticComponent<
    SidebarItemProps & React.RefAttributes<HTMLElement>
  >;
  RailMedia: typeof SidebarRailMedia;
  RailItem: React.ForwardRefExoticComponent<
    SidebarRailItemProps & React.RefAttributes<HTMLButtonElement>
  >;
};
//# sourceMappingURL=sidebar-content.d.ts.map
