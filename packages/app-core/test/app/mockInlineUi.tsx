import React from "react";

type InlineProps = React.PropsWithChildren<Record<string, unknown>>;
type SidebarHeaderSearchProps = React.InputHTMLAttributes<HTMLInputElement> & {
  clearLabel?: string;
  loading?: boolean;
  onClear?: () => void;
};

function passthrough({ children, ...props }: InlineProps) {
  return React.createElement("div", props, children);
}

function button({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return React.createElement("button", { type: "button", ...props }, children);
}

function input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return React.createElement("input", props);
}

function textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return React.createElement("textarea", props);
}

function dialogRoot({
  children,
  open,
}: React.PropsWithChildren<{ open?: boolean }>) {
  return open === false
    ? null
    : React.createElement(React.Fragment, null, children);
}

function pageLayout({
  children,
  sidebar,
  contentRef,
  ...props
}: React.PropsWithChildren<{
  sidebar?: React.ReactNode;
  contentRef?: React.Ref<HTMLElement>;
}>) {
  return React.createElement(
    "div",
    props,
    sidebar,
    React.createElement("main", { ref: contentRef }, children),
  );
}

function MockSidebar({
  children,
  header,
  footer,
  testId,
  collapsible = false,
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  collapsedContent,
  collapsedRailAction,
  collapsedRailItems,
  collapseButtonTestId,
  expandButtonTestId,
  collapseButtonAriaLabel,
  expandButtonAriaLabel,
  ...props
}: React.PropsWithChildren<{
  header?: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  collapsedContent?: React.ReactNode;
  collapsedRailAction?: React.ReactNode;
  collapsedRailItems?: React.ReactNode;
  collapseButtonTestId?: string;
  expandButtonTestId?: string;
  collapseButtonAriaLabel?: string;
  expandButtonAriaLabel?: string;
}>) {
  const [internalCollapsed, setInternalCollapsed] =
    React.useState(defaultCollapsed);
  const isCollapsed = collapsed ?? internalCollapsed;

  const setNextCollapsed = (next: boolean) => {
    if (collapsed === undefined) {
      setInternalCollapsed(next);
    }
    onCollapsedChange?.(next);
  };
  const collapsedRailContent =
    collapsedRailAction != null || collapsedRailItems != null
      ? React.createElement(
          React.Fragment,
          null,
          collapsedRailAction,
          collapsedRailItems,
        )
      : null;

  return React.createElement(
    "aside",
    {
      "data-testid": testId,
      "data-collapsed": isCollapsed || undefined,
      ...props,
    },
    isCollapsed && collapsible
      ? React.createElement(
          React.Fragment,
          null,
          collapsedContent ?? collapsedRailContent ?? children,
          React.createElement(
            "button",
            {
              type: "button",
              "data-testid": expandButtonTestId,
              "aria-label": expandButtonAriaLabel,
              onClick: () => setNextCollapsed(false),
            },
            "expand",
          ),
        )
      : React.createElement(
          React.Fragment,
          null,
          header,
          children,
          footer,
          collapsible
            ? React.createElement(
                "button",
                {
                  type: "button",
                  "data-testid": collapseButtonTestId,
                  "aria-label": collapseButtonAriaLabel,
                  onClick: () => setNextCollapsed(true),
                },
                "collapse",
              )
            : null,
        ),
  );
}

function sidebarHeader({
  children,
  search,
  ...props
}: React.PropsWithChildren<{
  search?: SidebarHeaderSearchProps;
}>) {
  const { clearLabel, loading, onClear, ...inputProps } = search ?? {};
  void clearLabel;
  void loading;
  void onClear;

  return React.createElement(
    "div",
    props,
    search ? React.createElement("input", inputProps) : null,
    children,
  );
}

export function createInlineUiMock<T extends Record<string, unknown>>(
  actual?: T,
) {
  return {
    ...actual,
    Button: button,
    Dialog: dialogRoot,
    DialogContent: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", { role: "dialog", ...props }, children),
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogTrigger: passthrough,
    DialogClose: passthrough,
    DialogOverlay: passthrough,
    DialogPortal: passthrough,
    DrawerSheet: dialogRoot,
    DrawerSheetContent: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("div", props, children),
    DrawerSheetDescription: passthrough,
    DrawerSheetHeader: passthrough,
    DrawerSheetOverlay: passthrough,
    DrawerSheetPortal: passthrough,
    DrawerSheetTitle: passthrough,
    Field: passthrough,
    FieldDescription: passthrough,
    FieldLabel: ({
      children,
      ...props
    }: React.LabelHTMLAttributes<HTMLLabelElement>) =>
      React.createElement("label", props, children),
    FieldMessage: passthrough,
    Input: input,
    PageLayout: pageLayout,
    Select: passthrough,
    SelectContent: passthrough,
    SelectItem: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement("option", props, children),
    SelectTrigger: button,
    SelectValue: passthrough,
    Sidebar: MockSidebar,
    SidebarHeader: sidebarHeader,
    SidebarHeaderStack: passthrough,
    SidebarPanel: passthrough,
    SidebarScrollRegion: passthrough,
    SidebarSearchBar: input,
    SidebarContent: {
      EmptyState: passthrough,
      Item: passthrough,
      ItemBody: passthrough,
      ItemButton: button,
      ItemDescription: passthrough,
      ItemIcon: passthrough,
      ItemTitle: passthrough,
      Notice: passthrough,
      RailItem: button,
      SectionHeader: passthrough,
      SectionLabel: passthrough,
      Toolbar: passthrough,
      ToolbarActions: passthrough,
      ToolbarPrimary: passthrough,
    },
    Textarea: textarea,
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(" "),
  };
}
