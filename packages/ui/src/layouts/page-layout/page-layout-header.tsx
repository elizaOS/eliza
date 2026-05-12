import type { HTMLAttributes } from "react";
import * as React from "react";

import { cn } from "../../lib/utils";

export interface PageLayoutHeaderProps extends HTMLAttributes<HTMLDivElement> {}

export function PageLayoutHeader({
  className,
  ...props
}: PageLayoutHeaderProps) {
  return React.createElement("div", {
    className: cn("mb-4 shrink-0", className),
    ...props,
  });
}
