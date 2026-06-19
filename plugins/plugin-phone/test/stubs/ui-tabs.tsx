import React from "react";

// Lightweight stand-in for @elizaos/ui's Radix-backed Tabs. Mirrors the real
// contract the component relies on: a single active value (controlled via
// `value` + `onValueChange`), triggers that switch the active value on click
// and carry role="tab", and content panes that only render when active.

type TabsCtx = {
  value: string;
  setValue: (next: string) => void;
};

const TabsContext = React.createContext<TabsCtx | null>(null);

type TabsProps = React.HTMLAttributes<HTMLDivElement> & {
  value?: string;
  onValueChange?: (next: string) => void;
};

export function Tabs({
  children,
  value,
  onValueChange,
  ...props
}: TabsProps): React.ReactElement {
  const ctx: TabsCtx = {
    value: value ?? "",
    setValue: (next) => onValueChange?.(next),
  };
  return React.createElement(
    TabsContext.Provider,
    { value: ctx },
    React.createElement("div", props, children),
  );
}

type TabsContentProps = React.HTMLAttributes<HTMLDivElement> & {
  value?: string;
};

export function TabsContent({
  children,
  value,
  ...props
}: TabsContentProps): React.ReactElement | null {
  const ctx = React.useContext(TabsContext);
  if (ctx && value !== undefined && ctx.value !== value) {
    return null;
  }
  return React.createElement("div", props, children);
}

type TabsListProps = React.HTMLAttributes<HTMLElement>;

export function TabsList({
  children,
  ...props
}: TabsListProps): React.ReactElement {
  return React.createElement("div", { role: "tablist", ...props }, children);
}

type TabsTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value?: string;
};

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  TabsTriggerProps
>(function TabsTrigger({ children, value, onClick, ...props }, ref) {
  const ctx = React.useContext(TabsContext);
  return React.createElement(
    "button",
    {
      ...props,
      ref,
      type: "button",
      role: "tab",
      "aria-selected": ctx ? ctx.value === value : undefined,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (value !== undefined) ctx?.setValue(value);
      },
    },
    children,
  );
});
