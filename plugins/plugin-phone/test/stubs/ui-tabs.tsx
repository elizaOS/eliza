import React from "react";

type ElementProps = React.HTMLAttributes<HTMLElement> & {
  value?: string;
};

export function Tabs({ children, ...props }: ElementProps): React.ReactElement {
  return React.createElement("div", props, children);
}

export function TabsContent({
  children,
  ...props
}: ElementProps): React.ReactElement {
  return React.createElement("div", props, children);
}

export function TabsList({
  children,
  ...props
}: ElementProps): React.ReactElement {
  return React.createElement("div", props, children);
}

export function TabsTrigger({
  children,
  ...props
}: ElementProps): React.ReactElement {
  return React.createElement("button", { ...props, type: "button" }, children);
}
