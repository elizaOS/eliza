import * as React from "react";
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Icon element rendered above the title */
  icon?: React.ReactNode;
  /** Main heading */
  title: string;
  /** Supporting description text */
  description?: string;
  /** Primary action button or element */
  action?: React.ReactNode;
  /** Visual density and framing. */
  variant?: "default" | "dashed" | "minimal";
}
export declare const EmptyState: React.ForwardRefExoticComponent<
  EmptyStateProps & React.RefAttributes<HTMLDivElement>
>;
//# sourceMappingURL=empty-state.d.ts.map
