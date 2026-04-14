import type * as React from "react";

import { cn } from "../../lib/utils";

export interface PageLayoutHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function PageLayoutHeader({
  className,
  ...props
}: PageLayoutHeaderProps) {
  return <div className={cn("mb-4 shrink-0", className)} {...props} />;
}
